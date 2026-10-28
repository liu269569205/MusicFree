/**
 * 歌曲备份与恢复（独立于通用「备份与恢复」的 WebDAV 配置）
 *
 * 两个独立功能，各自**按「磁盘上的完整文件名」精确对比差集**（不去前缀、不做模糊匹配）：
 *  - 备份：本地有、远端没有同名文件 → 上传（多线程）
 *  - 恢复：远端有、本地没有同名文件 → 下载（多线程，RNFS 原生流式落盘，不占 JS 内存）
 *
 * 传输过程中按「真实字节增量」统计实时速度（见 createSpeedMeter），通过 onProgress 上报。
 */
import { AuthType, createClient } from "webdav";
import RNFS from "react-native-fs";
import Config from "@/core/appConfig";
import { getDownloadDirFiles, getDownloadDirPath, invalidateDownloadDirCache } from "@/utils/mediaUtils";

const DEFAULT_REMOTE_DIR = "/MusicFree/SongBackup";

/** 并发数（多线程上传 / 下载） */
const CONCURRENCY = 3;

export interface ISongBackupProgress {
    done: number;
    total: number;
    name: string;
    uploaded: number;
    downloaded: number;
    skipped: number;
    failed: number;
    /** 最近一次失败的原因（用于进度框回显，便于排查） */
    error?: string;
    /** 已传输字节数（真实增减量，用于显示实时速度） */
    transferredBytes: number;
    /** 待传输总字节数（0 表示未知） */
    totalBytes: number;
    /** 实时速度，字节/秒（最近 3 秒滑动窗口） */
    speed: number;
    /** 当前方向：上传 / 下载 */
    direction: "upload" | "download";
}

/**
 * 滑动窗口速度计。
 *
 * 用最近 3 秒内的「累计字节增量 / 时间差」算瞬时速度，这样：
 *  - 速度会随实际带宽波动自然升降，而不是「总字节 / 总耗时」那种迟钝的平均值；
 *  - 传输结束后窗口内没有新增字节，速度会自动衰减到 0。
 */
function createSpeedMeter() {
    const WINDOW = 3000;
    const startedAt = Date.now();
    let total = 0;
    const samples: { t: number; b: number }[] = [];

    const trim = (now: number) => {
        while (samples.length > 1 && now - samples[0].t > WINDOW) {
            samples.shift();
        }
    };

    return {
        add(n: number) {
            if (!(n > 0)) {
                return;
            }
            total += n;
            const now = Date.now();
            samples.push({ t: now, b: total });
            if (samples.length > 300) {
                samples.splice(0, samples.length - 300);
            }
            trim(now);
        },
        get total() {
            return total;
        },
        speed(): number {
            if (!total) {
                return 0;
            }
            const now = Date.now();
            trim(now);
            const base = samples.length ? samples[0] : { t: startedAt, b: 0 };
            const dt = (now - base.t) / 1000;
            // 刚开始不足 0.3 秒时，按「总字节 / 总耗时」保守估算，避免瞬间天文数字
            if (dt < 0.3) {
                return total / Math.max(0.3, (now - startedAt) / 1000);
            }
            return (total - base.b) / dt;
        },
    };
}

export interface ISongBackupResult {
    total: number;
    uploaded: number;
    downloaded: number;
    skipped: number;
    failed: number;
}

type ProgressFn = (p: ISongBackupProgress) => void;

/** 取消标记（对话框里的「取消」按钮用） */
let cancelled = false;

/** 正在下载的任务：jobId → 本地目标文件（取消时中止并删除半成品） */
const activeDownloads = new Map<number, string>();
/** 正在上传的请求（取消时 abort，避免白等） */
const activeUploads = new Set<XMLHttpRequest>();
/** 等待取消的 resolver：让在途的传输立刻结束，不必等它自然收尾 */
let cancelWaiters: (() => void)[] = [];

function resetCancelWaiters() {
    cancelWaiters = [];
}

/** 会在取消时立刻 reject 的 Promise（与传输 Promise 一起 race） */
function waitCancel(): Promise<never> {
    return new Promise((_, reject) => {
        cancelWaiters.push(() => reject(new Error("CANCELLED")));
    });
}

/** 删除文件（不存在/删除失败都静默忽略） */
async function removeFileQuietly(path: string) {
    try {
        if (await RNFS.exists(path)) {
            await RNFS.unlink(path);
        }
    } catch {
        // 忽略
    }
}

/**
 * 取消当前进行的备份/恢复
 *  - 未完成（在途）的下载会被立刻中止，并删除已写了一半的文件；
 *  - 已经在队列里、还没开始的文件不会开始；
 *  - 已经完整传完的文件保留。
 */
export function cancelSongBackup() {
    if (cancelled) {
        return;
    }
    cancelled = true;
    // 中止在途下载 + 删半成品
    activeDownloads.forEach((target, jobId) => {
        try {
            RNFS.stopDownload(jobId);
        } catch {
            // 任务可能已结束
        }
        // 这里不 await：取消要立刻返回，downloadOne 的收尾里还会再删一次兜底
        void removeFileQuietly(target);
        // 原生下载线程可能还会把最后一块缓冲区写回文件，延迟再删一次并刷新索引
        setTimeout(() => {
            removeFileQuietly(target).then(() => invalidateDownloadDirCache());
        }, 800);
    });
    activeDownloads.clear();
    // 中止在途上传
    activeUploads.forEach(xhr => {
        try {
            xhr.abort();
        } catch {
            // 忽略
        }
    });
    activeUploads.clear();
    // 让 race 中的传输立刻结束
    const waiters = cancelWaiters;
    resetCancelWaiters();
    waiters.forEach(fn => fn());
}

function getClient() {
    const url = Config.getConfig("songBackup.webdav.url");
    const username = Config.getConfig("songBackup.webdav.username");
    const password = Config.getConfig("songBackup.webdav.password");
    if (!(url && username && password)) {
        throw new Error("SONGBACKUP_WEBDAV_NOT_CONFIGURED");
    }
    return createClient(url, {
        authType: AuthType.Password,
        username,
        password,
    });
}

function getRemoteDir() {
    const p = (Config.getConfig("songBackup.webdav.path") || DEFAULT_REMOTE_DIR)
        .trim()
        .replace(/\/+$/, "");
    return (p || DEFAULT_REMOTE_DIR) + "/";
}

/** 本地下载目录（裸路径，末尾保证一个 "/"，恢复时按目录写文件） */
function getLocalDir() {
    const p = getDownloadDirPath().replace(/[\/\\]+$/, "");
    return p + "/";
}

// ---- 不依赖 Node Buffer 的 base64 编解码（RN/Hermes 无 Buffer 全局）----
const B64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
        out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
    }
    return out;
}

/** 字符串 → UTF-8 字节（用于 Basic Auth 里的中文/特殊字符） */
function utf8Bytes(str: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            const c2 = str.charCodeAt(++i);
            const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            out.push(
                0xf0 | (cp >> 18),
                0x80 | ((cp >> 12) & 63),
                0x80 | ((cp >> 6) & 63),
                0x80 | (cp & 63),
            );
        } else {
            out.push(
                0xe0 | (c >> 12),
                0x80 | ((c >> 6) & 63),
                0x80 | (c & 63),
            );
        }
    }
    return new Uint8Array(out);
}

/** 远端文件条目：完整文件名 + 大小（大小用于计算恢复的进度总量） */
interface IRemoteEntry {
    name: string;
    size: number;
}

async function listRemoteFiles(
    client: any,
    dir: string,
): Promise<IRemoteEntry[]> {
    try {
        const items: any[] = await client.getDirectoryContents(dir, {
            deep: false,
        });
        return items
            .filter(it => it?.type === "file" && it?.basename)
            .map(it => ({
                name: it.basename as string,
                size: Number(it.size) || 0,
            }));
    } catch {
        return [];
    }
}

/** 本地文件条目：完整文件名（磁盘上的真实名字）/ 路径 / 大小 */
interface ILocalEntry {
    fullName: string;
    path: string;
    size: number;
}

async function listLocalFiles(): Promise<ILocalEntry[]> {
    const files = await getDownloadDirFiles(true);
    return Promise.all(
        files.map(async f => {
            const fullName =
                f.fullName || f.path.slice(f.path.lastIndexOf("/") + 1);
            let size = 0;
            try {
                size = Number((await RNFS.stat(f.path))?.size) || 0;
            } catch {
                // 拿不到大小就当未知，不影响传输，只影响「总量」显示
            }
            return { fullName, path: f.path, size };
        }),
    );
}

async function ensureLocalDir() {
    const dir = getLocalDir();
    try {
        if (!(await RNFS.exists(dir))) {
            await RNFS.mkdir(dir);
        }
    } catch {
        // 目录已存在或无权限，交给后续写入报错
    }
}

/** 简单并发池：最多 limit 个任务同时执行 */
async function runPool<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
) {
    let cursor = 0;
    const runners: Promise<void>[] = [];
    const size = Math.max(1, Math.min(limit, items.length));
    for (let i = 0; i < size; i++) {
        runners.push(
            (async () => {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    if (cancelled) {
                        return;
                    }
                    const idx = cursor++;
                    if (idx >= items.length) {
                        return;
                    }
                    await worker(items[idx]);
                }
            })(),
        );
    }
    await Promise.all(runners);
}

function authHeaders(): Record<string, string> {
    const username = Config.getConfig("songBackup.webdav.username") ?? "";
    const password = Config.getConfig("songBackup.webdav.password") ?? "";
    return {
        Authorization: `Basic ${bytesToBase64(utf8Bytes(`${username}:${password}`))}`,
        "Content-Type": "application/octet-stream",
    };
}

/** 文件在服务端的完整 URL（优先用 webdav 客户端拼，失败则手工拼） */
function fileUrl(client: any, remoteDir: string, name: string, kind: "download" | "upload") {
    try {
        const link =
            kind === "upload"
                ? client.getFileUploadLink(remoteDir + name)
                : client.getFileDownloadLink(remoteDir + name);
        if (link) {
            return link as string;
        }
    } catch {
        // 落到下面的手工拼接
    }
    const base = String(Config.getConfig("songBackup.webdav.url") ?? "")
        .trim()
        .replace(/\/+$/, "");
    return base + encodeURI(remoteDir + name).replace(/#/g, "%23");
}

/**
 * 上传单个文件
 *
 * 用 RN 的 XHR 原生「base64 请求体」上传：`xhr.send({ base64 })` 会被 RNCNetworking
 * 直接交给原生层（NetworkingModule 识别 string/uri/base64 三种 body），由原生解码成
 * 二进制流发出。这样既不会把二进制当字符串编码坏，也避开了两个坑：
 *  - webdav 的 putFileContents 在 RN 下传 Uint8Array 会失败；
 *  - RN 的 Blob 明确不支持 ArrayBuffer / TypedArray（会抛 not supported）。
 */
async function uploadOne(
    client: any,
    remoteDir: string,
    entry: ILocalEntry,
    onBytes?: (n: number) => void,
): Promise<void> {
    const b64 = await RNFS.readFile(entry.path, "base64");
    if (cancelled) {
        throw new Error("CANCELLED");
    }
    const url = fileUrl(client, remoteDir, entry.fullName, "upload");
    const headers = authHeaders();
    let xhrRef: XMLHttpRequest | null = null;
    const uploadPromise = new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef = xhr;
        xhr.open("PUT", url);
        Object.keys(headers).forEach(key => {
            xhr.setRequestHeader(key, headers[key]);
        });

        // 上传进度：RN 的 XHR 会把原生 didSendNetworkData 转成 upload progress 事件。
        // 拿不到 events 时（个别平台/版本）不影响功能，只是速度显示会退化成按文件大小估算。
        let sent = 0;
        const pushBytes = (n: number) => {
            if (n > 0) {
                sent += n;
                onBytes?.(n);
            }
        };
        try {
            if (xhr.upload) {
                xhr.upload.onprogress = (e: any) => {
                    const loaded = Number(e?.loaded) || 0;
                    pushBytes(loaded - sent);
                };
            }
        } catch {
            // 忽略：没有 upload 事件就用完成时补差
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                // 兜底：小文件可能没有任何 progress 回调，完成时按文件大小补差
                if (entry.size > sent) {
                    onBytes?.(entry.size - sent);
                }
                resolve();
            } else {
                reject(new Error(`HTTP ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.onabort = () => reject(new Error("CANCELLED"));
        xhr.ontimeout = () => reject(new Error("timeout"));
        // 原生层识别的二进制 body 写法
        xhr.send({ base64: b64 } as any);
    });
    // race 输掉时 uploadPromise 的 reject 不能被当成未捕获异常
    uploadPromise.catch(() => {});
    if (xhrRef) {
        activeUploads.add(xhrRef);
    }
    try {
        await Promise.race([uploadPromise, waitCancel()]);
    } finally {
        if (xhrRef) {
            activeUploads.delete(xhrRef);
        }
    }
}

/** 下载单个文件（RNFS 原生流式落盘，避免大文件占满 JS 堆） */
async function downloadOne(
    client: any,
    remoteDir: string,
    name: string,
    onBytes?: (n: number) => void,
): Promise<void> {
    const url = fileUrl(client, remoteDir, name, "download");
    const target = getLocalDir() + name;
    let written = 0;
    const job = RNFS.downloadFile({
        fromUrl: url,
        toFile: target,
        headers: authHeaders(),
        // 每 1% 回调一次，足够平滑又不会像 0 那样把桥打满
        progressDivider: 1,
        progress: r => {
            const delta = (r.bytesWritten || 0) - written;
            if (delta > 0) {
                written += delta;
                onBytes?.(delta);
            }
        },
    });
    // race 输掉时 job.promise 的 reject 不能被当成未捕获异常
    job.promise.catch(() => {});
    activeDownloads.set(job.jobId, target);

    try {
        const res = await Promise.race([job.promise, waitCancel()]);
        if (cancelled) {
            throw new Error("CANCELLED");
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            throw new Error(`HTTP ${res.statusCode}`);
        }
        // 兜底：小文件可能没有 progress 回调
        if ((res.bytesWritten || 0) > written) {
            onBytes?.((res.bytesWritten || 0) - written);
        }
    } catch (e) {
        // 取消 / 网络中断 / HTTP 错误：都不留半成品文件
        await removeFileQuietly(target);
        throw e;
    } finally {
        activeDownloads.delete(job.jobId);
    }
}

/** 备份本地下载歌曲到 WebDAV（只上传「远端不存在的完整文件名」） */
export async function backupSongs(
    onProgress?: ProgressFn,
): Promise<ISongBackupResult> {
    cancelled = false;
    resetCancelWaiters();
    const client = getClient();
    const remoteDir = getRemoteDir();
    await client.createDirectory(remoteDir, { recursive: true });

    const remoteItems = await listRemoteFiles(client, remoteDir);
    const remoteSet = new Set(remoteItems.map(it => it.name));
    const localFiles = await listLocalFiles();

    // 远端已存在的判定：**完整文件名精确相等**（不做前缀剥离、不做模糊匹配）
    const pending = localFiles.filter(f => !remoteSet.has(f.fullName));
    const skipped = localFiles.length - pending.length;
    const total = localFiles.length;
    const totalBytes = pending.reduce((sum, f) => sum + (f.size || 0), 0);

    let uploaded = 0;
    let failed = 0;
    let done = skipped;
    let lastErrorText = "";
    let currentName = "";
    let lastEmitAt = 0;
    const meter = createSpeedMeter();

    const emit = (force = false) => {
        if (!onProgress) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastEmitAt < 400) {
            return;
        }
        lastEmitAt = now;
        onProgress({
            done,
            total,
            name: currentName,
            uploaded,
            downloaded: 0,
            skipped,
            failed,
            error: lastErrorText || undefined,
            transferredBytes: meter.total,
            totalBytes,
            speed: meter.speed(),
            direction: "upload",
        });
    };

    if (!pending.length) {
        return {
            total,
            uploaded,
            downloaded: 0,
            skipped,
            failed,
        };
    }

    // 定时上报：即使某一刻没有字节增量，速度也会随窗口滑动自然衰减，不会「冻住」
    const ticker = onProgress ? setInterval(() => emit(false), 500) : null;

    try {
        await runPool(pending, CONCURRENCY, async entry => {
            currentName = entry.fullName;
            try {
                await uploadOne(client, remoteDir, entry, meter.add);
                uploaded++;
            } catch (e: any) {
                if (cancelled) {
                    // 用户取消：不算失败，也不再推进进度
                    return;
                }
                lastErrorText = `${entry.fullName}: ${String(e?.message ?? e)}`;
                failed++;
            }
            done++;
            emit(true);
        });
    } finally {
        if (ticker) {
            clearInterval(ticker);
        }
    }

    return { total, uploaded, downloaded: 0, skipped, failed };
}

/** 从 WebDAV 恢复歌曲到本地下载目录（只下载「本地不存在的完整文件名」） */
export async function restoreSongs(
    onProgress?: ProgressFn,
): Promise<ISongBackupResult> {
    cancelled = false;
    resetCancelWaiters();
    const client = getClient();
    const remoteDir = getRemoteDir();

    const remoteItems = await listRemoteFiles(client, remoteDir);
    if (!remoteItems.length) {
        throw new Error("SONGBACKUP_REMOTE_EMPTY");
    }
    const remoteNames = remoteItems.map(it => it.name);

    await ensureLocalDir();
    const localFiles = await listLocalFiles();
    // 本地已存在的判定：完整文件名精确相等
    const localSet = new Set<string>();
    const localSizeMap = new Map<string, number>();
    localFiles.forEach(f => {
        localSet.add(f.fullName);
        if (f.size > 0) {
            localSizeMap.set(f.fullName, f.size);
        }
    });

    // 待下载：
    //  1. 本地没有同名文件；
    //  2. 本地有同名文件但大小与远端不一致（取消/中断留下的半成品），需要重下覆盖。
    const pending = remoteItems.filter(it => {
        if (!localSet.has(it.name)) {
            return true;
        }
        const localSize = localSizeMap.get(it.name);
        return !!(it.size > 0 && localSize && localSize !== it.size);
    });
    const skipped = remoteNames.length - pending.length;
    const total = remoteNames.length;
    const totalBytes = pending.reduce((sum, it) => sum + (it.size || 0), 0);

    let downloaded = 0;
    let failed = 0;
    let done = skipped;
    let lastErrorText = "";
    let currentName = "";
    let lastEmitAt = 0;
    const meter = createSpeedMeter();

    const emit = (force = false) => {
        if (!onProgress) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastEmitAt < 400) {
            return;
        }
        lastEmitAt = now;
        onProgress({
            done,
            total,
            name: currentName,
            uploaded: 0,
            downloaded,
            skipped,
            failed,
            error: lastErrorText || undefined,
            transferredBytes: meter.total,
            totalBytes,
            speed: meter.speed(),
            direction: "download",
        });
    };

    if (!pending.length) {
        return { total, uploaded: 0, downloaded, skipped, failed };
    }

    const ticker = onProgress ? setInterval(() => emit(false), 500) : null;

    try {
        await runPool(pending, CONCURRENCY, async item => {
            currentName = item.name;
            try {
                await downloadOne(client, remoteDir, item.name, meter.add);
                downloaded++;
            } catch (e: any) {
                if (cancelled) {
                    // 用户取消：半成品已在 downloadOne 里删掉，不算失败
                    return;
                }
                lastErrorText = `${item.name}: ${String(e?.message ?? e)}`;
                failed++;
            }
            done++;
            emit(true);
        });
    } finally {
        if (ticker) {
            clearInterval(ticker);
        }
    }

    invalidateDownloadDirCache();
    return { total, uploaded: 0, downloaded, skipped, failed };
}
