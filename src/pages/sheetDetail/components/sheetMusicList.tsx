import React from "react";
import Header from "./header";
import MusicList from "@/components/musicList";
import { useParams } from "@/core/router";
import HorizontalSafeAreaView from "@/components/base/horizontalSafeAreaView.tsx";
import globalStyle from "@/constants/globalStyle";
import { useSheetItem } from "@/core/musicSheet";
import { RequestStateCode } from "@/constants/commonConst";
import { useCurrentMusic } from "@/core/trackPlayer";

interface ISheetMusicListProps {
    /** 覆盖路由参数里的歌单 id（横屏分屏时使用） */
    sheetId?: string;
    /** 是否展示歌单头部（封面 + 播放全部） */
    showHeader?: boolean;
    /** 挂载后自动定位到当前播放歌曲 */
    autoScrollToHighlight?: boolean;
    /** 外部触发回到第一条：传入一个自增的信号值 */
    scrollToTopSignal?: number;
}

export default function SheetMusicList({
    sheetId: overrideId,
    showHeader = true,
    autoScrollToHighlight,
    scrollToTopSignal,
}: ISheetMusicListProps) {
    // 分屏场景下不在路由内，useParams 可能为 undefined，需要兜底
    const paramId = useParams<"local-sheet-detail">()?.id ?? "favorite";
    const id = overrideId ?? paramId;
    const musicSheet = useSheetItem(id);
    const currentMusic = useCurrentMusic();

    return (
        <HorizontalSafeAreaView style={globalStyle.flex1}>
            <MusicList
                Header={showHeader ? <Header sheetId={id} /> : undefined}
                musicList={musicSheet?.musicList}
                musicSheet={musicSheet}
                showIndex
                state={RequestStateCode.IDLE}
                highlightMusicItem={currentMusic}
                autoScrollToHighlight={autoScrollToHighlight}
                scrollToTopSignal={scrollToTopSignal}
            />
        </HorizontalSafeAreaView>
    );
}
