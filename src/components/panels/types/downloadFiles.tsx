import React, { useCallback, useEffect, useState } from "react";
import {
    FlatList,
    Pressable,
    StyleSheet,
    TouchableOpacity,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import rpx, { vh } from "@/utils/rpx";
import globalStyle from "@/constants/globalStyle";
import ThemeText from "@/components/base/themeText";
import PanelBase from "../base/panelBase";
import PanelHeader from "../base/panelHeader";
import Icon from "@/components/base/icon";
import IconButton from "@/components/base/iconButton";
import Toast from "@/utils/toast";
import {
    buildLocalMusicItemFromFile,
    deleteDownloadFile,
    getMatchedDownloadFiles,
    IDownloadDirFile,
} from "@/utils/mediaUtils";
import {
    clearSongFileOverride,
    getSongFileOverride,
    setSongFileOverride,
} from "@/utils/songFileOverride";
import TrackPlayer from "@/core/trackPlayer";
import useColors from "@/hooks/useColors";

interface IDownloadFilesProps {
    /** 歌曲信息 */
    musicItem: IMusic.IMusicItem;
}

/** 某首歌在下载目录中匹配到的文件列表（试听 / 指定使用 / 删除） */
export default function DownloadFiles(props: IDownloadFilesProps) {
    const { musicItem } = props ?? {};
    const colors = useColors();
    const safeAreaInsets = useSafeAreaInsets();
    const [files, setFiles] = useState<IDownloadDirFile[]>([]);
    const [loading, setLoading] = useState(true);
    /** 当前「指定使用」的文件（裸路径），null 表示自动匹配 */
    const [overridePath, setOverridePath] = useState<string | null>(
        () => getSongFileOverride(musicItem),
    );

    const refresh = useCallback(() => {
        setOverridePath(getSongFileOverride(musicItem));
        getMatchedDownloadFiles(musicItem, true)
            .then(list => setFiles(list))
            .catch(() => setFiles([]))
            .finally(() => setLoading(false));
    }, [musicItem]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // 临时探针（已停用自动滚动，避免干扰手势测试）

    const onDelete = (file: IDownloadDirFile) => {
        deleteDownloadFile(file.path)
            .then(() => {
                // 删掉的正好是「指定使用」的文件 → 一并清掉指定，回到自动匹配
                if (overridePath === file.path) {
                    clearSongFileOverride(musicItem);
                }
                Toast.success("已删除文件");
                refresh();
            })
            .catch(() => {
                Toast.warn("删除失败");
            });
    };

    const onPlay = (file: IDownloadDirFile) => {
        const localItem = buildLocalMusicItemFromFile(file);
        TrackPlayer.play(localItem, undefined, false)
            .then(() => {
                Toast.success("开始播放");
            })
            .catch(() => {
                Toast.warn("播放失败");
            });
    };

    /**
     * 指定/取消「这首歌使用哪个文件」。
     * 下载目录里可能出现同名不同作者、或多版本的同名文件，自动匹配会串文件，
     * 这里让用户手动钉住一个；指定后播放、蓝勾判定都优先用它。
     */
    const onToggleUse = (file: IDownloadDirFile) => {
        const isCurrent = overridePath === file.path;
        if (isCurrent) {
            clearSongFileOverride(musicItem);
            Toast.success("已取消指定，恢复自动匹配");
        } else {
            setSongFileOverride(musicItem, file.path);
            Toast.success("已指定该文件，播放时优先使用");
        }
        setOverridePath(getSongFileOverride(musicItem));
    };

    const currentFileName = overridePath
        ? files.find(f => f.path === overridePath)?.name
        : undefined;

    return (
        <PanelBase
            height={vh(75)}
            renderBody={() => (
                <View style={globalStyle.flex1}>
                    <PanelHeader
                        title={`「${musicItem?.title ?? ""}」下载文件 (${files.length})`}
                        hideButtons
                        hideDivider
                    />
                    <View style={styles.tipRow}>
                        <ThemeText
                            fontSize="description"
                            fontColor="textSecondary"
                            numberOfLines={1}>
                            {overridePath
                                ? `当前指定：${
                                      currentFileName ??
                                      overridePath.split("/").pop()
                                  }`
                                : "同名不同作者容易串文件 · 点右侧圆点可指定使用"}
                        </ThemeText>
                    </View>
                    <View style={styles.body}>
                        <FlatList
                            data={files}
                            keyExtractor={item => item.path}
                            contentContainerStyle={{
                                paddingBottom: safeAreaInsets.bottom,
                            }}
                            ListEmptyComponent={
                                loading ? null : (
                                    <View style={styles.empty}>
                                        <ThemeText fontColor="textSecondary">
                                            没有匹配的下载文件
                                        </ThemeText>
                                    </View>
                                )
                            }
                            renderItem={({ item }) => {
                                const isCurrent = overridePath === item.path;
                                return (
                                    <Pressable
                                        style={[
                                            styles.item,
                                            {
                                                borderBottomColor:
                                                    colors.divider,
                                            },
                                        ]}
                                        onPress={() => onPlay(item)}>
                                        <View style={styles.fileInfo}>
                                            <ThemeText
                                                style={styles.fileName}
                                                numberOfLines={2}>
                                                {item.name}
                                            </ThemeText>
                                            <ThemeText
                                                fontSize="description"
                                                fontColor={
                                                    isCurrent
                                                        ? "primary"
                                                        : "textSecondary"
                                                }
                                                numberOfLines={1}>
                                                {isCurrent
                                                    ? "当前使用 · 点击试听"
                                                    : "点击试听"}
                                            </ThemeText>
                                        </View>
                                        <TouchableOpacity
                                            style={styles.actionBtn}
                                            activeOpacity={0.6}
                                            onPress={() => onToggleUse(item)}>
                                            <Icon
                                                name={
                                                    isCurrent
                                                        ? "check-circle"
                                                        : "check-circle-outline"
                                                }
                                                size={rpx(42)}
                                                color={
                                                    isCurrent
                                                        ? colors.primary
                                                        : colors.textSecondary
                                                }
                                            />
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={styles.actionBtn}
                                            activeOpacity={0.6}
                                            onPress={() => onDelete(item)}>
                                            <IconButton
                                                name="trash-outline"
                                                accessibilityLabel="删除"
                                            />
                                        </TouchableOpacity>
                                    </Pressable>
                                );
                            }}
                        />
                    </View>
                </View>
            )}
        />
    );
}

const styles = StyleSheet.create({
    tipRow: {
        paddingHorizontal: rpx(24),
        paddingBottom: rpx(12),
    },
    body: {
        flex: 1,
        minHeight: rpx(300),
    },
    empty: {
        padding: rpx(60),
        alignItems: "center",
    },
    item: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: rpx(24),
        paddingVertical: rpx(20),
        borderBottomWidth: rpx(1),
    },
    fileInfo: {
        flex: 1,
        marginRight: rpx(16),
    },
    fileName: {
        marginBottom: rpx(6),
    },
    actionBtn: {
        width: rpx(72),
        height: rpx(72),
        alignItems: "center",
        justifyContent: "center",
    },
});
