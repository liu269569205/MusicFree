import React, { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import NavBar from "./components/navBar";
import MusicBar from "@/components/musicBar";
import { createDrawerNavigator } from "@react-navigation/drawer";
import HomeDrawer from "./components/drawer";
import { SafeAreaView } from "react-native-safe-area-context";
import StatusBar from "@/components/base/statusBar";
import HorizontalSafeAreaView from "@/components/base/horizontalSafeAreaView.tsx";
import globalStyle from "@/constants/globalStyle";
import Theme from "@/core/theme";
import HomeBody from "./components/homeBody";
import HomeBodyHorizontal from "./components/homeBodyHorizontal";
import useOrientation from "@/hooks/useOrientation";
import { ROUTE_PATH, useNavigate } from "@/core/router";
import PersistStatus from "@/utils/persistStatus";
import rpx from "@/utils/rpx";
import SheetSplitView from "./components/sheetSplitView";
import { SplitContext } from "./splitContext";

function Home() {
    const orientation = useOrientation();
    const navigate = useNavigate();

    const isLandscape = orientation === "horizontal";

    /** 横屏分屏展示的歌单：启动时恢复上次打开的 */
    const [splitSheetId, setSplitSheetId] = useState<string | null>(
        () => PersistStatus.get("app.lastSplitSheetId") ?? "favorite",
    );
    /** 歌单面板是否在左侧（持久化，下次启动保持） */
    const [playlistOnLeft, setPlaylistOnLeft] = useState<boolean>(
        () => PersistStatus.get("app.splitPlaylistOnLeft") ?? true,
    );
    /** 仅启动恢复时自动定位到当前播放歌曲，切换歌单不再自动定位 */
    const [autoScrollToHighlight, setAutoScrollToHighlight] =
        useState<boolean>(true);

    const ctx = {
        splitSheetId,
        playlistOnLeft,
        openLocalSheet: (id: string) => {
            if (isLandscape) {
                PersistStatus.set("app.lastSplitSheetId", id);
                setSplitSheetId(id);
                setAutoScrollToHighlight(false);
            } else {
                navigate(ROUTE_PATH.LOCAL_SHEET_DETAIL, { id });
            }
        },
        closeSplit: () => {
            PersistStatus.set("app.lastSplitSheetId", undefined);
            setSplitSheetId(null);
        },
        toggleSides: () => {
            const next = !playlistOnLeft;
            PersistStatus.set("app.splitPlaylistOnLeft", next);
            setPlaylistOnLeft(next);
        },
    };

    /** 首页栏：导航栏 + 首页内容 + 播放栏（播放栏因此只占本栏宽度） */
    const homePane = (
        <View style={globalStyle.flex1}>
            <HorizontalSafeAreaView style={globalStyle.flex1}>
                <NavBar />
                {isLandscape ? <HomeBodyHorizontal /> : <HomeBody />}
            </HorizontalSafeAreaView>
            <MusicBar />
        </View>
    );

    /** 歌单栏 */
    const playlistPane = splitSheetId ? (
        <SheetSplitView
            sheetId={splitSheetId}
            autoScrollToHighlight={autoScrollToHighlight}
        />
    ) : (
        <View style={globalStyle.flex1} />
    );

    return (
        <SplitContext.Provider value={ctx}>
            <SafeAreaView edges={["top", "bottom"]} style={styles.appWrapper}>
                <HomeStatusBar />
                {isLandscape ? (
                    <View
                        style={[
                            styles.splitRoot,
                            {
                                // 用 row-reverse 对调而非交换子元素，避免整树重建丢滚动位置
                                flexDirection: playlistOnLeft
                                    ? "row-reverse"
                                    : "row",
                            },
                        ]}>
                        {homePane}
                        <View
                            style={[
                                styles.playlistPane,
                                playlistOnLeft
                                    ? styles.boundaryOnRight
                                    : styles.boundaryOnLeft,
                            ]}>
                            {playlistPane}
                        </View>
                    </View>
                ) : (
                    homePane
                )}
            </SafeAreaView>
        </SplitContext.Provider>
    );
}

function HomeStatusBar() {
    const theme = Theme.useTheme();

    return (
        <StatusBar
            backgroundColor="transparent"
            barStyle={theme.dark ? undefined : "dark-content"}
        />
    );
}

const LeftDrawer = createDrawerNavigator();
export default function App() {
    const { width, height } = useWindowDimensions();
    // 横屏时抽屉按短边取 80%，避免占满整块横向空间
    const drawerWidth =
        width > height ? Math.min(width, height) * 0.8 : ("80%" as const);

    return (
        <LeftDrawer.Navigator
            screenOptions={{
                headerShown: false,
                drawerStyle: {
                    width: drawerWidth,
                },
            }}
            initialRouteName="HOME-MAIN"
            drawerContent={props => <HomeDrawer {...props} />}>
            <LeftDrawer.Screen name="HOME-MAIN" component={Home} />
        </LeftDrawer.Navigator>
    );
}

const styles = StyleSheet.create({
    appWrapper: {
        flexDirection: "column",
        flex: 1,
    },
    splitRoot: {
        flex: 1,
        flexDirection: "row",
    },
    playlistPane: {
        flex: 1,
    },
    boundaryOnLeft: {
        borderLeftWidth: rpx(1),
        borderLeftColor: "rgba(128,128,128,0.3)",
    },
    boundaryOnRight: {
        borderRightWidth: rpx(1),
        borderRightColor: "rgba(128,128,128,0.3)",
    },
});
