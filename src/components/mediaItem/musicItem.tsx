import React, { useEffect, useMemo, useState } from "react";
import { StyleProp, StyleSheet, TouchableOpacity, View, ViewStyle } from "react-native";
import rpx from "@/utils/rpx";
import { musicListItemHeight } from "@/constants/uiConst";
import ListItem from "../base/listItem";

import LocalMusicSheet from "@/core/localMusicSheet";
import { showPanel } from "../panels/usePanel";
import TitleAndTag from "./titleAndTag";
import ThemeText from "../base/themeText";
import TrackPlayer from "@/core/trackPlayer";
import Icon from "@/components/base/icon.tsx";
import Tag from "../base/tag";
import {
    getDownloadDirFiles,
    getDownloadFileCountSync,
    getLocalPathWithFallback,
    isDownloadedMediaItem,
    isDownloadDirReady,
    onDownloadDirChanged,
} from "@/utils/mediaUtils";
import { onSongFileOverrideChanged } from "@/utils/songFileOverride";
import useColors from "@/hooks/useColors";

/**
 * 下载目录索引的版本号：索引首次加载完成 / 目录发生增删时自增，
 * 用于驱动列表按最新的目录索引重新计算「已下载」与数字角标。
 */
function useDownloadDirTick() {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        let cancelled = false;
        getDownloadDirFiles()
            .then(() => {
                if (!cancelled) {
                    setTick(t => t + 1);
                }
            })
            .catch(() => {});
        // 目录索引失效后在 mediaUtils 内部会重扫完再发事件，这里直接刷新即可
        const off = onDownloadDirChanged(() => setTick(t => t + 1));
        // 手动指定「使用哪个文件」后也要刷新蓝勾/角标
        const offOverride = onSongFileOverrideChanged(() =>
            setTick(t => t + 1),
        );
        return () => {
            cancelled = true;
            off();
            offOverride();
        };
    }, []);
    return tick;
}

/** 是否已下载（含回退匹配：下载目录中存在「歌名@作者」文件） */
function useIsDownloaded(musicItem: IMusic.IMusicItem | null) {
    const tick = useDownloadDirTick();
    const [fallbackHit, setFallbackHit] = useState(false);
    // 同步判定：依赖 mediaExtra 与已加载的目录索引
    const syncResult = useMemo(
        () => (musicItem ? isDownloadedMediaItem(musicItem) : false),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [musicItem, tick],
    );
    useEffect(() => {
        let cancelled = false;
        setFallbackHit(false);
        if (!musicItem || syncResult) {
            return;
        }
        // 索引已加载完成时，同步结果就是权威结论，不再逐行发起异步回退扫描。
        // 否则首屏几百行会同时调用 getLocalPathWithFallback（内部对每个候选文件做
        // RNFS exists），桥与 JS 线程被占满，表现为「刚进 App 时列表点不动」。
        if (isDownloadDirReady()) {
            return;
        }
        // 索引未初始化时异步扫描一次，命中后刷新
        getLocalPathWithFallback(musicItem)
            .then(path => {
                if (!cancelled) {
                    setFallbackHit(!!path);
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [musicItem, syncResult]);
    return syncResult || fallbackHit;
}

/** 下载目录中匹配该歌曲的文件数量（同步计算，避免行复用残留上一首的数字） */
function useDownloadFileCount(musicItem: IMusic.IMusicItem | null) {
    const tick = useDownloadDirTick();
    return useMemo(
        () => getDownloadFileCountSync(musicItem),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [musicItem, tick],
    );
}

interface IMusicItemProps {
    index?: string | number;
    showMoreIcon?: boolean;
    musicItem: IMusic.IMusicItem;
    musicSheet?: IMusic.IMusicSheetItem;
    onItemPress?: (musicItem: IMusic.IMusicItem) => void;
    onItemLongPress?: () => void;
    itemPaddingRight?: number;
    left?: () => JSX.Element;
    containerStyle?: StyleProp<ViewStyle>;
    highlight?: boolean
    /** 点击播放时是否自动下载（默认 true；搜索结果传 false） */
    autoDownload?: boolean;
}
export default function MusicItem(props: IMusicItemProps) {
    const {
        musicItem,
        index,
        onItemPress,
        onItemLongPress,
        musicSheet,
        itemPaddingRight,
        showMoreIcon = true,
        left: Left,
        containerStyle,
        highlight = false,
        autoDownload,
    } = props;

    const isLocal = !!LocalMusicSheet.isLocalMusic(musicItem);
    const isDownloaded = useIsDownloaded(musicItem);
    const downloadCount = useDownloadFileCount(musicItem);
    const colors = useColors();
    const playingColor = colors.textHighlight ?? colors.primary;

    // 下载目录中匹配该歌曲的文件数量角标（点击打开文件管理面板）
    // 注意：外层 ListItem 是 TouchableHighlight（JS responder），gesture-handler 的
    // Pressable 抢不到触摸、会穿透成「播放整行」（还会触发自动下载）。
    // 这里用 RN 的 TouchableOpacity —— 与 ListItemIcon（⋮ 按钮）同一套机制，实测可拦下点击。
    const countBadge =
        downloadCount && downloadCount > 0 ? (
            <TouchableOpacity
                activeOpacity={0.6}
                hitSlop={{
                    top: rpx(16),
                    bottom: rpx(16),
                    left: rpx(16),
                    right: rpx(16),
                }}
                onPress={() => {
                    showPanel("DownloadFiles", { musicItem });
                }}>
                <Tag
                    tagName={String(downloadCount)}
                    containerStyle={styles.countBadge}
                />
            </TouchableOpacity>
        ) : null;

    return (
        <ListItem
            heightType="big"
            style={[styles.compactRow, containerStyle]}
            withHorizontalPadding
            leftPadding={index !== undefined ? 0 : undefined}
            rightPadding={itemPaddingRight}
            onLongPress={onItemLongPress}
            onPress={() => {
                if (onItemPress) {
                    onItemPress(musicItem);
                } else {
                    TrackPlayer.play(musicItem, undefined, autoDownload);
                }
            }}>
            {Left ? <Left /> : null}
            {index !== undefined ? (
                highlight ? (
                    // 正在播放：序号位置显示律动图标，比只改文字颜色更容易一眼看到
                    <View style={styles.playingIndex}>
                        <Icon
                            name="bars-3"
                            size={rpx(30)}
                            color={playingColor}
                        />
                    </View>
                ) : (
                    <ListItem.ListItemText
                        width={rpx(86)}
                        position="none"
                        fixedWidth
                        fontColor="text"
                        contentStyle={styles.indexText}>
                        {index}
                    </ListItem.ListItemText>
                )
            ) : null}
            <ListItem.Content
                title={
                    <TitleAndTag
                        title={musicItem.title}
                        titleFontColor={highlight ? "primary": "text"}
                        tag={musicItem.platform}
                        tagLeading={countBadge}
                        // 点击右侧插件源标签 → 换源。
                        // 注意：不要按 isLocal 禁用 —— 已下载/本地歌单里的歌也会走这里，
                        // 禁用后表现为「有的行能点、有的行点了变成播放」。
                        onTagPress={() =>
                            showPanel("SwitchSource", {
                                musicItem,
                                musicSheet,
                            })
                        }
                    />
                }
                description={
                    <View style={styles.descContainer}>
                        {(isLocal || isDownloaded) && (
                            <Icon
                                style={styles.icon}
                                color="#11659a"
                                name="check-circle"
                                size={rpx(22)}
                            />
                        )}
                        <ThemeText
                            numberOfLines={1}
                            fontSize="description"
                            fontColor={highlight ? "primary" : "textSecondary"}>
                            {musicItem.artist}
                            {musicItem.album ? ` - ${musicItem.album}` : ""}
                        </ThemeText>
                    </View>
                }
            />
            {showMoreIcon ? (
                <ListItem.ListItemIcon
                    width={rpx(48)}
                    hitSlop={{
                        left: rpx(24),
                        right: rpx(24),
                    }}
                    position="none"
                    icon="ellipsis-vertical"
                    onPress={() => {
                        showPanel("MusicItemOptions", {
                            musicItem,
                            musicSheet,
                        });
                    }}
                />
            ) : null}
        </ListItem>
    );
}

const styles = StyleSheet.create({
    // 歌曲行比 ListItem 的 big(120) 更紧凑，列表行间距更小
    // 高度必须用共享常量：musicList 的滚动定位按时高 × 索引计算偏移
    compactRow: {
        height: musicListItemHeight,
    },
    icon: {
        marginRight: rpx(6),
    },
    descContainer: {
        flexDirection: "row",
        marginTop: rpx(10),
    },
    // 数字角标位于「源标签」左侧（标题右侧），间距由 Tag 自身的 marginLeft 提供
    countBadge: {
        marginLeft: 0,
        marginRight: 0,
    },

    indexText: {
        fontStyle: "italic",
        textAlign: "center",
        padding: rpx(2),
    },
    // 与序号列同宽，保证正在播放/普通行的标题左边界对齐
    playingIndex: {
        width: rpx(86),
        flexBasis: rpx(86),
        flexShrink: 0,
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
    },
});
