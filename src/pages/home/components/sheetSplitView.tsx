import React, { useCallback, useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import SheetMusicList from "@/pages/sheetDetail/components/sheetMusicList";
import ThemeText from "@/components/base/themeText";
import { useSheetItem } from "@/core/musicSheet";
import globalStyle from "@/constants/globalStyle";
import rpx from "@/utils/rpx";

interface IProps {
    sheetId: string;
    /** 启动恢复时自动定位到当前播放歌曲 */
    autoScrollToHighlight?: boolean;
}

/**
 * 横屏分屏模式下的歌单面板
 * 顶部仅保留一行紧凑标题，不放置关闭按钮，最大化歌曲列表空间
 * 长按标题：列表回到第一条
 */
export default function SheetSplitView({
    sheetId,
    autoScrollToHighlight,
}: IProps) {
    const sheet = useSheetItem(sheetId);
    const [scrollToTopSignal, setScrollToTopSignal] = useState(0);

    const handleLongPressTitle = useCallback(() => {
        setScrollToTopSignal(prev => prev + 1);
    }, []);

    return (
        <View style={globalStyle.fwflex1}>
            <View style={styles.titleBar}>
                {/* 长按歌单名称 → 列表滚回第一条 */}
                <TouchableOpacity
                    activeOpacity={0.7}
                    delayLongPress={350}
                    onLongPress={handleLongPressTitle}
                    style={styles.titleText}>
                    <ThemeText fontSize="title" numberOfLines={1}>
                        {sheet?.title ?? ""}
                    </ThemeText>
                </TouchableOpacity>
                <ThemeText
                    fontColor="textSecondary"
                    fontSize="subTitle"
                    numberOfLines={1}>
                    {sheet?.musicList?.length ?? 0}
                </ThemeText>
            </View>
            <SheetMusicList
                sheetId={sheetId}
                showHeader={false}
                autoScrollToHighlight={autoScrollToHighlight}
                scrollToTopSignal={scrollToTopSignal}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    titleBar: {
        width: "100%",
        height: rpx(72),
        paddingHorizontal: rpx(24),
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },
    titleText: {
        flex: 1,
        height: "100%",
        justifyContent: "center",
        marginRight: rpx(12),
    },
});
