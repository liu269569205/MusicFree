import {
    internalSerializeKey,
    localPluginPlatform,
    supportLocalMediaType,
} from "@/constants/commonConst";
import appConfig from "@/core/appConfig";
import pathConst from "@/constants/pathConst";
import { addFileScheme, escapeCharacter } from "@/utils/fileUtils";
import { getMediaExtraProperty, patchMediaExtra } from "./mediaExtra";
import { exists, readDir, unlink } from "react-native-fs";
import EventEmitter from "eventemitter3";
import {
    clearSongFileOverride,
    getSongFileOverride,
} from "./songFileOverride";

/**
 * 获取媒体资源的唯一key
 * @param mediaItem 
 * @returns 
 */
export function getMediaUniqueKey(mediaItem: ICommon.IMediaBase) {
    return `${mediaItem.platform}@${mediaItem.id}`;
}

/**
 * 解析媒体资源的唯一key
 * @param key 
 * @returns 
 */
export function parseMediaUniqueKey(key: string): ICommon.IMediaBase {
    try {
        const str = JSON.parse(key.trim());
        let platform, id;
        if (typeof str === "string") {
            [platform, id] = str.split("@");
        } else {
            platform = str?.platform;
            id = str?.id;
        }
        if (!platform || !id) {
            throw new Error("mediakey不完整");
        }
        return {
            platform,
            id,
        };
    } catch (e: any) {
        throw e;
    }
}

/**
 * 比较两个媒体资源是否相同
 * @param a 
 * @param b 
 * @returns 
 */
export function isSameMediaItem(
    a: ICommon.IMediaBase | null | undefined,
    b: ICommon.IMediaBase | null | undefined,
) {
    // eslint-disable-next-line eqeqeq
    return !!(a && b && a.id == b.id && a.platform === b.platform);
}


/** 获取复位的mediaItem */
export function resetMediaItem<T extends ICommon.IMediaBase>(
    mediaItem: T,
    platform?: string,
    newObj?: boolean,
): T {
    // 本地音乐不做处理
    if (
        mediaItem.platform === localPluginPlatform ||
        platform === localPluginPlatform
    ) {
        return newObj ? { ...mediaItem } : mediaItem;
    }
    if (!newObj) {
        mediaItem.platform = platform ?? mediaItem.platform;
        mediaItem[internalSerializeKey] = undefined;
        return mediaItem;
    } else {
        return {
            ...mediaItem,
            platform: platform ?? mediaItem.platform,
            [internalSerializeKey]: undefined,
        };
    }
}

/**
 * 获取媒体资源的本地路径，如果本地路径不存在，则返回null
 * @param mediaItem 
 * @returns 
 */
export function getLocalPath(mediaItem: ICommon.IMediaBase) {
    if (!mediaItem) {
        return null;
    }

    // 如果本身就是一个内部音乐
    if (mediaItem.url && (mediaItem.url.startsWith("file://") || mediaItem.url.startsWith("content://"))) {
        return mediaItem.url;
    }

    // 尝试从内部数据中获取 -- legacy logic
    const legacyLocalPath = mediaItem?.[internalSerializeKey]?.localPath;
    if (legacyLocalPath && typeof legacyLocalPath === "string") {
        return legacyLocalPath;
    }

    // 从附加信息中获取
    const localPathInMediaExtra = getMediaExtraProperty(mediaItem, "localPath");

    return localPathInMediaExtra ?? null;
}

/** 下载目录文件索引缓存（避免列表渲染时反复 readDir） */
export interface IDownloadDirFile {
    /** 逻辑名（旧版前缀已去掉，形如「插件名@id@歌名@作者.mp3」） */
    name: string;
    /** 磁盘上的完整文件名（可能带旧版前缀，如「music元力QQ@id@歌名@作者.mp3」） */
    fullName: string;
    path: string;
}
let downloadDirCache: IDownloadDirFile[] | null = null;
let downloadDirCacheTime = 0;
let downloadDirInFlight: Promise<IDownloadDirFile[]> | null = null;
/** 目录失效后的合并重扫定时器（避免连续多次下载触发多次 readDir） */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const DOWNLOAD_DIR_CACHE_TTL = 30 * 1000; // 30 秒

/** 下载目录匹配计数缓存：key 为「歌名@作者」，value 为该歌匹配的文件数 */
let downloadCountCache: Map<string, number> | null = null;

/** 下载目录变化事件（文件增删后通知列表角标刷新） */
const dlChangeEmitter = new EventEmitter();

/** 订阅下载目录变化（返回取消订阅函数） */
export function onDownloadDirChanged(cb: () => void): () => void {
    dlChangeEmitter.on("change", cb);
    return () => {
        dlChangeEmitter.off("change", cb);
    };
}

/** 获取下载目录文件索引（带 TTL 缓存；下载完成后调用 invalidateDownloadDirCache 刷新）
 *  - 并发调用共享同一次 readDir（in-flight 守卫），避免列表大量 item 同时挂载时重复扫描目录
 */
export async function getDownloadDirFiles(force = false): Promise<IDownloadDirFile[]> {
    const now = Date.now();
    if (
        !force &&
        downloadDirCache &&
        now - downloadDirCacheTime < DOWNLOAD_DIR_CACHE_TTL
    ) {
        return downloadDirCache;
    }
    if (downloadDirInFlight) {
        return downloadDirInFlight;
    }
    const run = async (): Promise<IDownloadDirFile[]> => {
        // RNFS 的 readDir/exists/unlink 在 Android 上要求「裸路径」，
        // 带 file:// 前缀会直接失败，这里统一去掉 scheme（兼容用户在设置里填带前缀的路径）。
        const dlPath = getDownloadDirPath();
        const collected: IDownloadDirFile[] = [];
        const seen = new Set<string>();
        const collect = (files: any[], namePrefix = "") => {
            for (const file of files) {
                if (file?.isDirectory?.()) {
                    continue;
                }
                const lowerPath = String(file.path ?? "").toLowerCase();
                if (!supportLocalMediaType.some(ext => lowerPath.endsWith(ext))) {
                    continue;
                }
                if (namePrefix && !file.name.startsWith(namePrefix)) {
                    continue;
                }
                if (seen.has(file.path)) {
                    continue;
                }
                seen.add(file.path);
                collected.push({
                    name: namePrefix
                        ? file.name.slice(namePrefix.length)
                        : file.name,
                    fullName: file.name,
                    path: file.path,
                });
            }
        };
        // 1) 标准位置：下载目录本身（新版下载器发现路径末尾无 "/" 时会补上，
        //    文件落在 .../Download/music/ 子目录里）
        const mainPath = dlPath.replace(/[\/\\]+$/, "");
        try {
            collect(await readDir(mainPath));
        } catch {
            // 目录可能还不存在，忽略
        }
        // 2) 兼容旧版：路径末尾无 "/" 时，旧下载器把最后一段直接拼在文件名前，
        //    文件落在父目录、名字形如「music元力QQ@id@歌名@作者.mp3」，这里读父目录、
        //    按前缀过滤，并把前缀从文件名中去掉。
        if (!dlPath.endsWith("/") && !dlPath.endsWith("\\")) {
            const lastSlash = mainPath.lastIndexOf("/");
            if (lastSlash > 0) {
                const namePrefix = mainPath.slice(lastSlash + 1);
                if (namePrefix) {
                    try {
                        collect(
                            await readDir(mainPath.slice(0, lastSlash + 1)),
                            namePrefix,
                        );
                    } catch {
                        // 父目录不可读时忽略
                    }
                }
            }
        }
        try {
            downloadDirCache = collected;
            downloadDirCacheTime = Date.now();
        } catch {
            downloadDirCache = downloadDirCache ?? [];
        } finally {
            downloadDirInFlight = null;
        }
        return downloadDirCache;
    };
    downloadDirInFlight = run();
    return downloadDirInFlight;
}

/** 使下载目录索引失效（下载完成 / 文件被删除后调用）
 *  - 不清空现有索引，只清掉计数缓存，并「合并」触发一次异步重扫；
 *    重扫完成后原子替换索引再通知列表刷新。
 *    这样做有两点好处：
 *    1. 索引清空后如果没有任何地方重新加载，列表里的数字角标会全部变 0 且长期不恢复
 *       （行只在挂载时拉一次索引）；
 *    2. 保留旧索引可以避免「下载完成瞬间所有角标闪一下 0 再回来」。
 */
export function invalidateDownloadDirCache() {
    downloadCountCache = null;
    if (reloadTimer) {
        return;
    }
    reloadTimer = setTimeout(() => {
        reloadTimer = null;
        getDownloadDirFiles(true)
            .catch(() => {})
            .then(() => {
                dlChangeEmitter.emit("change");
            });
    }, 300);
}

/** 下载目录索引是否已加载完成（加载后 isDownloadedMediaItem 的结果即权威，
 *  列表行无需再去做异步回退扫描 —— 否则首屏几百行会同时发 RNFS 调用，
 *  桥线程被占满，表现为「刚打开 App 时点不动列表，滑动一下之后才正常」。 */
export function isDownloadDirReady(): boolean {
    return !!downloadDirCache;
}

/** 当前配置的下载目录（裸路径，去掉 file:// 前缀） */
export function getDownloadDirPath(): string {
    const configured =
        appConfig.getConfig("basic.downloadPath") ?? pathConst.downloadMusicPath;
    return configured.startsWith("file://")
        ? configured.slice("file://".length)
        : configured;
}

/** 文件名是否匹配：优先「歌名@作者」，退而求其次同时包含歌名与作者
 *  - loose=true 时再放宽为「文件名包含完整歌名」即算命中（用于数字角标/文件面板，
 *    兼容用户从别处拷贝进来、文件名只有歌名的音频文件）
 */
function isFilenameMatch(
    name: string,
    title: string,
    artist: string,
    keyword: string,
    loose = false,
) {
    if (name.includes(keyword)) {
        return true;
    }
    if (
        artist &&
        name.includes(escapeCharacter(title)) &&
        name.includes(escapeCharacter(artist))
    ) {
        return true;
    }
    if (loose) {
        const escapedTitle = escapeCharacter(title);
        // 过短的歌名（1 个字）容易误匹配，不做放宽
        if (escapedTitle.length >= 2 && name.includes(escapedTitle)) {
            return true;
        }
    }
    return false;
}

/**
 * 返回下载目录中匹配该歌曲的文件列表（用于歌曲列表数字角标与文件管理面板）。
 * 优先精确匹配「歌名@作者」，其次同时包含歌名与作者，最后放宽为文件名包含完整歌名。
 */
export async function getMatchedDownloadFiles(
    mediaItem: ICommon.IMediaBase | null | undefined,
    force = false,
): Promise<IDownloadDirFile[]> {
    const title = mediaItem?.title ?? "";
    const artist = mediaItem?.artist ?? "";
    if (!title) {
        return [];
    }
    const keyword = `${escapeCharacter(title)}@${escapeCharacter(artist)}`;
    if (keyword.length <= 1) {
        return [];
    }
    let files: IDownloadDirFile[] = [];
    try {
        files = await getDownloadDirFiles(force);
    } catch {
        return [];
    }
    return files.filter(file =>
        isFilenameMatch(file.name, title, artist, keyword, true),
    );
}

/**
 * 同步取某首歌在下载目录中匹配的文件数量（供列表数字角标）。
 * 直接基于已加载的目录索引同步计算，**不返回 Promise**，因此列表行复用（FlashList）
 * 时不会出现「上一首的数字残留」。索引未加载时返回 0，加载完成后由
 * `onDownloadDirChanged` 触发列表重渲染再取到真实值。
 * 结果按「歌名@作者」缓存，目录变化时清空。
 */
export function getDownloadFileCountSync(
    mediaItem: ICommon.IMediaBase | null | undefined,
): number {
    const title = mediaItem?.title ?? "";
    const artist = mediaItem?.artist ?? "";
    if (!title) {
        return 0;
    }
    const keyword = `${escapeCharacter(title)}@${escapeCharacter(artist)}`;
    if (keyword.length <= 1) {
        return 0;
    }
    if (downloadCountCache) {
        const cached = downloadCountCache.get(keyword);
        if (cached !== undefined) {
            return cached;
        }
    }
    const files = downloadDirCache;
    let count = 0;
    if (files && files.length) {
        for (const file of files) {
            if (isFilenameMatch(file.name, title, artist, keyword, true)) {
                count += 1;
            }
        }
        // 兜底：文件名匹配不上（例如歌名只有 1 个字、或文件被重命名），但 mediaExtra
        // 记录的 localPath 确实在下载目录里，也计 1，避免「有勾没数字」。
        if (count === 0) {
            const localPath = toBarePath(
                mediaItem ? getLocalPath(mediaItem) : null,
            );
            if (localPath && files.some(file => file.path === localPath)) {
                count = 1;
            }
        }
    }
    if (!downloadCountCache) {
        downloadCountCache = new Map<string, number>();
    }
    // 索引尚未加载时不写缓存，避免把「暂时为空」永久记成 0
    if (files) {
        downloadCountCache.set(keyword, count);
    }
    return count;
}

/**
 * 取某首歌在下载目录中匹配「歌名@作者」的文件数量（用于列表项数字角标）。
 * 与「文件列表面板」共用 getMatchedDownloadFiles 的匹配逻辑（歌名@作者，含模糊回退），
 * 保证角标数字与面板列出的文件数完全一致。
 *  - 文件列表索引（getDownloadDirFiles）带 TTL 与并发共享，故每行仅一次内存过滤，不会反复磁盘扫描；
 *  - 额外按「歌名@作者」缓存计数，同一首歌多次出现时直接命中。
 */
export async function getDownloadFileCount(
    mediaItem: ICommon.IMediaBase | null | undefined,
): Promise<number> {
    if (!mediaItem?.title) {
        return 0;
    }
    const keyword = `${escapeCharacter(mediaItem.title ?? "")}@${escapeCharacter(
        mediaItem.artist ?? "",
    )}`;
    if (keyword.length <= 1) {
        return 0;
    }
    try {
        if (downloadCountCache) {
            const cached = downloadCountCache.get(keyword);
            if (cached !== undefined) {
                return cached;
            }
        }
        const files = await getMatchedDownloadFiles(mediaItem);
        const count = files.length;
        if (!downloadCountCache) {
            downloadCountCache = new Map<string, number>();
        }
        downloadCountCache.set(keyword, count);
        return count;
    } catch {
        return 0;
    }
}

/** 删除下载目录中的某个文件，并刷新索引缓存 */
export async function deleteDownloadFile(filePath: string): Promise<void> {
    try {
        await unlink(
            filePath.startsWith("file://")
                ? filePath.slice("file://".length)
                : filePath,
        );
    } catch {
        // 忽略删除异常（文件可能已被外部移除）
    } finally {
        invalidateDownloadDirCache();
    }
}

/**
 * 由下载目录文件构造一个可播放的本地音乐项（用于文件管理面板直接试听）。
 * 文件名约定：「插件名@id@歌名@作者.后缀」
 */
export function buildLocalMusicItemFromFile(
    file: IDownloadDirFile,
): IMusic.IMusicItem {
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const parts = baseName.split("@");
    let title = baseName;
    let artist = "";
    if (parts.length >= 4) {
        title = parts[2] ?? title;
        artist = parts.slice(3).join("@") || "";
    }
    return {
        id: file.path,
        platform: localPluginPlatform,
        title,
        artist,
        url: addFileScheme(file.path),
        duration: 0,
    } as IMusic.IMusicItem;
}

/** 去掉 file:// 前缀（RNFS 与本地路径比较一律用裸路径） */
function toBarePath(path: string | null | undefined): string | null {
    if (!path) {
        return null;
    }
    return path.startsWith("file://") ? path.slice("file://".length) : path;
}

/**
 * 同步判断媒体是否已下载（供列表「已下载」蓝勾使用）。
 *
 * 判定优先级（与数字角标口径保持一致，保证「有勾必有数字」）：
 * 1. 目录索引已加载时，只认真实存在的文件：
 *    - mediaExtra 记录的 localPath 在下载目录索引中；
 *    - 下载目录里有文件名匹配该歌曲的文件。
 *    localPath 一律先去掉 file:// 前缀再比较，否则「file:///storage/...」既匹配不到索引、
 *    又会因不以 /storage/... 开头被误判成「下载目录之外的本地文件」而误显示勾。
 * 2. 目录索引尚未加载时，退回 mediaExtra / downloaded 标记，等索引就绪后由
 *    `onDownloadDirChanged` 触发重渲染再校正。
 */
export function isDownloadedMediaItem(mediaItem: ICommon.IMediaBase): boolean {
    if (!mediaItem) {
        return false;
    }
    // 用户在文件面板里手动指定过文件 → 视为已下载（播放时也优先用它）。
    // 索引已加载且指定文件已不在磁盘上时不认（避免删了文件还显示蓝勾）。
    const overridePath = getSongFileOverride(mediaItem);
    if (overridePath) {
        if (!downloadDirCache) {
            return true;
        }
        if (downloadDirCache.some(file => file.path === overridePath)) {
            return true;
        }
    }
    const title = mediaItem.title ?? "";
    const artist = mediaItem.artist ?? "";
    const localPath = toBarePath(getLocalPath(mediaItem));
    const files = downloadDirCache;

    // 目录索引已加载：以磁盘上的真实文件为准
    if (files) {
        if (localPath && files.some(file => file.path === localPath)) {
            return true;
        }
        if (!title) {
            return false;
        }
        const keyword = `${escapeCharacter(title)}@${escapeCharacter(artist)}`;
        if (keyword.length <= 1) {
            return false;
        }
        return files.some(file =>
            isFilenameMatch(file.name, title, artist, keyword, true),
        );
    }

    // 索引未加载：退回历史记录
    if (localPath) {
        return true;
    }
    if (getMediaExtraProperty(mediaItem, "downloaded")) {
        return true;
    }
    return false;
}

/**
 * 获取媒体资源的本地路径（带回退）。
 *
 * 优先走「原方式」：通过 platform@id 关联的 mediaExtra / 内部数据定位已下载文件；
 * 如果该方式找不到（例如用户更换了插件源，导致 platform 与 id 发生变化，
 * 但磁盘上仍保留着之前以「插件名@id@歌名@作者」命名的文件），
 * 则回退到在下载目录中查找文件名包含「歌名@作者」的文件，
 * 从而兼容更换插件源后依旧能识别并播放原先下载的文件。
 *
 * 命中回退后会将路径写入 mediaExtra 缓存，后续调用走原方式即可，无需再次扫描目录。
 *
 * @param mediaItem 媒体资源
 * @returns 本地路径，找不到时返回 null
 */
export async function getLocalPathWithFallback(
    mediaItem: ICommon.IMediaBase,
): Promise<string | null> {
    if (!mediaItem) {
        return null;
    }

    // 0. 用户在文件面板里手动指定的文件最优先（解决同名不同作者串文件的问题）
    const overridePath = getSongFileOverride(mediaItem);
    if (overridePath) {
        try {
            if (await exists(overridePath)) {
                return overridePath;
            }
            // 指定文件已被删除 → 清掉映射，回退自动匹配
            clearSongFileOverride(mediaItem);
        } catch {
            clearSongFileOverride(mediaItem);
        }
    }

    // 1. 原方式：platform@id 关联的路径
    const standardPath = getLocalPath(mediaItem);
    if (standardPath) {
        try {
            if (await exists(standardPath)) {
                return standardPath;
            }
        } catch {
            /* 路径无效，继续回退 */
        }
    }

    // 2. 回退：根据「歌名@作者」在下载目录中查找
    const title = mediaItem.title ?? "";
    const artist = mediaItem.artist ?? "";
    if (!title) {
        return null;
    }
    const keyword = `${escapeCharacter(title)}@${escapeCharacter(artist)}`;
    // 关键字必须含有效内容，避免误匹配
    if (keyword.length <= 1) {
        return null;
    }

    const dlPath =
        appConfig.getConfig("basic.downloadPath") ?? pathConst.downloadMusicPath;

    let files: IDownloadDirFile[] = [];
    try {
        files = await getDownloadDirFiles();
    } catch {
        return null;
    }

    // 优先精确匹配「歌名@作者」
    for (const file of files) {
        if (file.name.includes(keyword)) {
            // 校验文件仍存在（索引可能是缓存的）
            try {
                if (!(await exists(file.path))) {
                    invalidateDownloadDirCache();
                    continue;
                }
            } catch {
                continue;
            }
            // 缓存，便于下次走原方式
            try {
                patchMediaExtra(mediaItem, {
                    localPath: file.path,
                    downloaded: true,
                });
            } catch {
                /* 忽略缓存失败 */
            }
            return file.path;
        }
    }
    // 文件名可能因总长度超过 200 字符被截断，退而求其次：
    // 同时包含「歌名」与「作者」两个片段（顺序不限），提高命中率
    if (artist) {
        for (const file of files) {
            if (
                file.name.includes(escapeCharacter(title)) &&
                file.name.includes(escapeCharacter(artist))
            ) {
                try {
                    if (!(await exists(file.path))) {
                        invalidateDownloadDirCache();
                        continue;
                    }
                } catch {
                    continue;
                }
                try {
                    patchMediaExtra(mediaItem, {
                        localPath: file.path,
                        downloaded: true,
                    });
                } catch {
                    /* 忽略缓存失败 */
                }
                return file.path;
            }
        }
    }

    return null;
}