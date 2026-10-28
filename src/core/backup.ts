/** 备份与恢复 */
/** 歌单、插件、WebDAV 配置 */
import { compare } from "compare-versions";
import PluginManager from "./pluginManager";
import MusicSheet from "@/core/musicSheet";
import Config from "@/core/appConfig";
import type { IAppConfigProperties } from "@/types/core/config";
import { ResumeMode } from "@/constants/commonConst.ts";

/**
 * 结果：一份大的json文件
 * {
 *     musicSheets: [],
 *     plugins: [],
 *     webdavConfigs: {},
 * }
 */

/** 需要随备份一起保存的 WebDAV 配置键（通用备份 + 歌曲备份） */
const WEBDAV_CONFIG_KEYS = [
    "webdav.url",
    "webdav.username",
    "webdav.password",
    "songBackup.webdav.url",
    "songBackup.webdav.username",
    "songBackup.webdav.password",
    "songBackup.webdav.path",
] as const;

type WebdavConfigKey = (typeof WEBDAV_CONFIG_KEYS)[number];

type WebdavConfigs = Partial<Record<WebdavConfigKey, string>>;

interface IBackJson {
    musicSheets: IMusic.IMusicSheetItem[];
    plugins: Array<{ srcUrl: string; version: string }>;
    /** WebDAV 配置，只记录有值的键 */
    webdavConfigs?: WebdavConfigs;
}

function backupWebdavConfigs(): WebdavConfigs {
    const configs: WebdavConfigs = {};
    for (const key of WEBDAV_CONFIG_KEYS) {
        const value = Config.getConfig(key as keyof IAppConfigProperties);
        if (value) {
            configs[key] = value as string;
        }
    }
    return configs;
}

function resumeWebdavConfigs(configs?: WebdavConfigs) {
    if (!configs) {
        return;
    }
    for (const key of WEBDAV_CONFIG_KEYS) {
        const value = configs[key];
        // 逐键写入，备份里缺失的键不会清空设备上已有的配置
        if (value !== undefined && value !== null) {
            Config.setConfig(key as keyof IAppConfigProperties, value as never);
        }
    }
}

function backup() {
    const musicSheets = MusicSheet.backupSheets();
    const plugins = PluginManager.getEnabledPlugins();
    const normalizedPlugins = plugins.map(_ => ({
        srcUrl: _.instance.srcUrl,
        version: _.instance.version,
    }));

    return JSON.stringify({
        musicSheets: musicSheets,
        plugins: normalizedPlugins,
        webdavConfigs: backupWebdavConfigs(),
    });
}

async function resume(
    raw: string | Object,
    resumeMode: ResumeMode = ResumeMode.Append,
) {
    let obj: IBackJson;
    if (typeof raw === "string") {
        obj = JSON.parse(raw);
    } else {
        obj = raw as IBackJson;
    }

    const { plugins, musicSheets, webdavConfigs } = obj ?? {};

    /** 恢复 WebDAV 配置 */
    resumeWebdavConfigs(webdavConfigs);

    /** 恢复插件 */
    const validPlugins = PluginManager.getEnabledPlugins();
    const resumePlugins = plugins?.map(_ => {
        // 校验是否安装过: 同源且本地版本更高就忽略掉
        if (
            validPlugins.find(
                plugin =>
                    plugin.instance.srcUrl === _.srcUrl &&
                    compare(
                        plugin.instance.version ?? "0.0.0",
                        _.version ?? "0.0.1",
                        ">=",
                    ),
            )
        ) {
            return;
        }
        return PluginManager.installPluginFromUrl(_.srcUrl);
    });

    /** 恢复歌单 */
    const resumeMusicSheets = MusicSheet.resumeSheets(musicSheets, resumeMode);

    return Promise.all([...(resumePlugins ?? []), resumeMusicSheets]);
}

const Backup = {
    backup,
    resume,
};
export default Backup;
