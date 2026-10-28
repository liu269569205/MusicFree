import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import rpx from "@/utils/rpx";
import { hideDialog } from "../useDialog";
import Dialog from "./base";
import { useI18N } from "@/core/i18n";
import ThemeText from "@/components/base/themeText";
import type { ISongBackupProgress } from "@/core/songBackup";

interface ISongBackupProgressDialogProps {
    title: string;
    /** task 接收 report 回调用于上报进度，返回结果 */
    task: (report: (p: ISongBackupProgress) => void) => Promise<any>;
    onResolve?: (data: any, hideDialog: () => void) => void;
    onReject?: (reason: any, hideDialog: () => void) => void;
    onCancel?: (hideDialog: () => void) => void;
}

const EMPTY: ISongBackupProgress = {
    done: 0,
    total: 0,
    name: "",
    uploaded: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    transferredBytes: 0,
    totalBytes: 0,
    speed: 0,
    direction: "upload",
};

/** 字节数 → 可读大小 */
function formatBytes(n: number) {
    if (!n || n < 0) {
        return "0 B";
    }
    if (n < 1024) {
        return `${Math.round(n)} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    if (n < 1024 * 1024 * 1024) {
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 字节/秒 → 可读速度 */
function formatSpeed(bps: number) {
    return `${formatBytes(bps)}/s`;
}

export default function SongBackupProgressDialog(
    props: ISongBackupProgressDialogProps,
) {
    const { title, task, onResolve, onReject, onCancel } = props;
    const { t } = useI18N();
    const [progress, setProgress] = useState<ISongBackupProgress>(EMPTY);

    useEffect(() => {
        task(setProgress)
            .then(data => onResolve?.(data, hideDialog))
            .catch(e => onReject?.(e, hideDialog));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const pct =
        progress.total > 0
            ? Math.floor((progress.done / progress.total) * 100)
            : 0;

    // 按字节的进度（更贴近真实传输感受，文件数进度会一顿一顿的）
    const bytePct =
        progress.totalBytes > 0
            ? Math.min(
                  100,
                  (progress.transferredBytes / progress.totalBytes) * 100,
              )
            : 0;

    const speedText = progress.speed > 0 ? formatSpeed(progress.speed) : "—";
    const arrow = progress.direction === "upload" ? "↑" : "↓";
    const transferText =
        progress.totalBytes > 0
            ? `${formatBytes(progress.transferredBytes)} / ${formatBytes(
                  progress.totalBytes,
              )}`
            : formatBytes(progress.transferredBytes);

    return (
        <Dialog onDismiss={hideDialog}>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Content style={style.content}>
                <ThemeText fontSize="content" fontWeight="bold">
                    {pct}%
                </ThemeText>
                <View style={style.barBg}>
                    <View style={[style.barFg, { width: `${pct}%` }]} />
                </View>
                {progress.totalBytes > 0 ? (
                    <View style={style.byteBarBg}>
                        <View
                            style={[style.byteBarFg, { width: `${bytePct}%` }]}
                        />
                    </View>
                ) : null}
                <ThemeText fontSize="subTitle" numberOfLines={1}>
                    {progress.done}/{progress.total}
                    {progress.name ? `  ${progress.name}` : ""}
                </ThemeText>
                <View style={style.speedRow}>
                    <ThemeText
                        fontSize="subTitle"
                        fontWeight="bold"
                        fontColor="primary"
                        style={style.speed}>
                        {arrow} {speedText}
                    </ThemeText>
                    <ThemeText
                        fontSize="subTitle"
                        fontColor="textSecondary"
                        numberOfLines={1}>
                        {t("songBackup.transferred")} {transferText}
                    </ThemeText>
                </View>
                <ThemeText fontSize="subTitle">
                    {t("songBackup.uploaded")}:{progress.uploaded}  {t(
                        "songBackup.downloaded",
                    )}:{progress.downloaded}  {t("songBackup.skipped")}:
                    {progress.skipped}  {t("songBackup.failed")}:
                    {progress.failed}
                </ThemeText>
                {progress.error ? (
                    <ThemeText
                        fontSize="subTitle"
                        fontColor="textSecondary"
                        numberOfLines={2}
                        style={style.error}>
                        {progress.error}
                    </ThemeText>
                ) : null}
            </Dialog.Content>
            <Dialog.Actions
                actions={[
                    {
                        title: t("common.cancel"),
                        onPress() {
                            onCancel?.(hideDialog);
                        },
                    },
                ]}
            />
        </Dialog>
    );
}

const style = StyleSheet.create({
    content: {
        height: rpx(460),
        justifyContent: "center",
    },
    barBg: {
        width: "100%",
        height: rpx(16),
        borderRadius: rpx(8),
        backgroundColor: "rgba(255,255,255,0.15)",
        overflow: "hidden",
        marginTop: rpx(20),
    },
    barFg: {
        height: "100%",
        backgroundColor: "#4caf50",
    },
    byteBarBg: {
        width: "100%",
        height: rpx(8),
        borderRadius: rpx(4),
        backgroundColor: "rgba(255,255,255,0.10)",
        overflow: "hidden",
        marginTop: rpx(8),
        marginBottom: rpx(16),
    },
    byteBarFg: {
        height: "100%",
        backgroundColor: "#2196f3",
    },
    speedRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: rpx(10),
    },
    speed: {
        marginRight: rpx(20),
    },
    error: {
        marginTop: rpx(16),
    },
});
