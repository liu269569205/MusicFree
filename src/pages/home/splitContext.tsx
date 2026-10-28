import React, { useContext } from "react";

export interface ISplitContext {
    /** 横屏分屏时展示的歌单 id */
    splitSheetId: string | null;
    /** 歌单面板是否在左侧 */
    playlistOnLeft: boolean;
    /** 打开本地歌单：横屏走分屏，竖屏走路由 */
    openLocalSheet: (id: string) => void;
    /** 关闭分屏面板 */
    closeSplit: () => void;
    /** 左右对调（并持久化） */
    toggleSides: () => void;
}

const defaultContext: ISplitContext = {
    splitSheetId: null,
    playlistOnLeft: true,
    openLocalSheet: () => {},
    closeSplit: () => {},
    toggleSides: () => {},
};

export const SplitContext = React.createContext<ISplitContext>(defaultContext);

export function useSplitContext() {
    return useContext(SplitContext);
}
