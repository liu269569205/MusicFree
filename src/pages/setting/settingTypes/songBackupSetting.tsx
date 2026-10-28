import ListItem, { ListItemHeader } from "@/components/base/listItem";
import { ROUTE_PATH, useNavigate } from "@/core/router";
import Toast from "@/utils/toast";
import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import { showDialog } from "@/components/dialogs/useDialog";
import { showPanel } from "@/components/panels/usePanel";
import Config, { useAppConfig } from "@/core/appConfig";
import { useI18N } from "@/core/i18n";
import { backupSongs, cancelSongBackup, restoreSongs } from "@/core/songBackup";
import type { ISongBackupResult } from "@/core/songBackup";

export default function SongBackupSetting() {
    const { t } = useI18N();
    const navigate = useNavigate();

    const webdavUrl = useAppConfig("songBackup.webdav.url");
    const webdavUsername = useAppConfig("songBackup.webdav.username");
    const webdavPassword = useAppConfig("songBackup.webdav.password");
    const webdavPath = useAppConfig("songBackup.webdav.path");

    const openWebdavSettings = () => {
        showPanel("SetUserVariables", {
            title: t("songBackup.webdavSettings"),
            initValues: {
                url: webdavUrl ?? "",
                username: webdavUsername ?? "",
                password: webdavPassword ?? "",
                path: webdavPath ?? "",
            },
            variables: [
                { key: "url", name: "URL", hint: t("songBackup.webdavUrl") },
                { key: "username", name: t("common.username") },
                { key: "password", name: t("common.password") },
                { key: "path", name: t("songBackup.webdavPath") },
            ],
            onOk(values, closePanel) {
                Config.setConfig("songBackup.webdav.url", values?.url);
                Config.setConfig(
                    "songBackup.webdav.username",
                    values?.username,
                );
                Config.setConfig(
                    "songBackup.webdav.password",
                    values?.password,
                );
                Config.setConfig("songBackup.webdav.path", values?.path);
                Toast.success(t("toast.saveSuccess"));
                closePanel();
            },
        });
    };

    const handleReject = (reason: any, hide: () => void) => {
        hide();
        const msg = (reason as Error)?.message;
        if (msg === "SONGBACKUP_WEBDAV_NOT_CONFIGURED") {
            Toast.warn(t("songBackup.webdavNotConfigured"));
        } else if (msg === "SONGBACKUP_REMOTE_EMPTY") {
            Toast.warn(t("songBackup.remoteDirEmpty"));
        } else {
            Toast.warn(
                t("toast.resumeFail", {
                    reason: msg ?? reason,
                }),
            );
        }
    };

    /** 统一的任务运行器：进度对话框 + 取消（取消会立刻中止在途传输并删除未完成的文件） */
    const runTask = (
        title: string,
        task: (report: (p: any) => void) => Promise<ISongBackupResult>,
        buildToast: (r: ISongBackupResult) => void,
    ) => {
        let cancelledByUser = false;
        showDialog("SongBackupProgressDialog", {
            title,
            task: async report => {
                const result = await task(report);
                if (cancelledByUser) {
                    Toast.warn(t("songBackup.cancelled"));
                } else {
                    buildToast(result);
                }
                return result;
            },
            onResolve: (_: any, hide: () => void) => hide(),
            onReject: handleReject,
            onCancel: (hide: () => void) => {
                cancelledByUser = true;
                cancelSongBackup();
                hide();
            },
        });
    };

    const resultText = (r: ISongBackupResult) =>
        `${t("songBackup.uploaded")}:${r.uploaded}, ${t(
            "songBackup.downloaded",
        )}:${r.downloaded}, ${t("songBackup.skipped")}:${r.skipped}, ${t(
            "songBackup.failed",
        )}:${r.failed}`;

    const onBackup = () => {
        runTask(
            t("songBackup.backupToWebdav"),
            async report => backupSongs(report),
            result => {
                if (!result.total) {
                    Toast.warn(t("songBackup.noLocalSongs"));
                } else {
                    Toast.success(
                        `${t("songBackup.backupSuccess")} (${resultText(result)})`,
                    );
                }
            },
        );
    };

    const onRestore = () => {
        runTask(
            t("songBackup.resumeFromWebdav"),
            async report => restoreSongs(report),
            result => {
                Toast.success(
                    `${t("songBackup.resumeSuccess")} (${resultText(result)})`,
                );
            },
        );
    };

    return (
        <ScrollView style={style.wrapper}>
            <ListItemHeader>{t("sidebar.songBackupAndRestore")}</ListItemHeader>
            <ListItem withHorizontalPadding onPress={openWebdavSettings}>
                <ListItem.Content title={t("songBackup.webdavSettings")} />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onBackup}>
                <ListItem.Content
                    title={t("songBackup.backupToWebdav")}
                    description="按完整文件名对比：只上传 Webdav 上不存在的文件（多线程）"
                />
            </ListItem>
            <ListItem withHorizontalPadding onPress={onRestore}>
                <ListItem.Content
                    title={t("songBackup.resumeFromWebdav")}
                    description="按完整文件名对比：只下载本地不存在的文件（多线程，取消会删除未下完的文件）"
                />
            </ListItem>
        </ScrollView>
    );
}

const style = StyleSheet.create({
    wrapper: {
        width: "100%",
        flex: 1,
    },
});
