import React, { useEffect, useState } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { FlatList, Pressable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import rpx, { vh } from "@/utils/rpx";
import ListItem from "@/components/base/listItem";
import ThemeText from "@/components/base/themeText";
import { iconSizeConst } from "@/constants/uiConst";
import useColors from "@/hooks/useColors";
import Toast from "@/utils/toast";
import { hidePanel } from "../usePanel";
import PanelBase from "../base/panelBase";
import PanelHeader from "../base/panelHeader";
import globalStyle from "@/constants/globalStyle";
import pluginManager, { Plugin } from "@/core/pluginManager";
import MusicSheet from "@/core/musicSheet";
import TrackPlayer from "@/core/trackPlayer";
import Downloader from "@/core/downloader";
import MediaCache from "@/core/mediaCache";
import {
    getLocalPathWithFallback,
    invalidateDownloadDirCache,
} from "@/utils/mediaUtils";
import { unlink } from "react-native-fs";
import Divider from "@/components/base/divider";

interface ISwitchSourceProps {
    /** 当前歌曲 */
    musicItem: IMusic.IMusicItem;
    /** 当前歌曲所在歌单（用于就地换源替换） */
    musicSheet?: IMusic.IMusicSheetItem;
}

export default function SwitchSource(props: ISwitchSourceProps) {
    const { musicItem, musicSheet } = props ?? {};
    const safeAreaInsets = useSafeAreaInsets();
    const colors = useColors();

    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
    const [titleKw, setTitleKw] = useState(musicItem?.title ?? "");
    const [artistKw, setArtistKw] = useState(musicItem?.artist ?? "");
    const [results, setResults] = useState<IMusic.IMusicItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [keyboardVisible, setKeyboardVisible] = useState(false);

    // 监听键盘：弹起时压缩面板到只显示搜索框（保证输入框在键盘上方且不出屏），
    // 收起时恢复全高显示列表（Manifest 为 adjustResize，无需 KeyboardAvoidingView）
    useEffect(() => {
        const showSub = Keyboard.addListener("keyboardDidShow", () =>
            setKeyboardVisible(true),
        );
        const hideSub = Keyboard.addListener("keyboardDidHide", () =>
            setKeyboardVisible(false),
        );
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    useEffect(() => {
        // 系统已安装且支持搜索的插件（按用户排序）
        setPlugins(pluginManager.getSortedPluginsWithAbility("search"));
    }, []);

    // 选择插件后自动按当前歌名+作者搜索（用 effect 触发，避免手动调用时机问题）
    useEffect(() => {
        if (selectedPlugin) {
            doSearch(selectedPlugin);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPlugin]);

    // 组装搜索关键字：歌名 + 作者（空格分隔，符合插件搜索惯例）
    function buildKeyword() {
        const t = titleKw.trim();
        const a = artistKw.trim();
        if (!t) return "";
        return a ? `${t} ${a}` : t;
    }

    async function doSearch(plugin: Plugin) {
        const q = buildKeyword();
        if (!q) {
            Toast.warn("请输入歌名");
            return;
        }
        setLoading(true);
        setSearched(true);
        setResults([]);
        // 先收键盘再搜：键盘弹起时面板只显示搜索框（列表整块被隐藏），
        // 若不收起，用户会看到「搜索有结果但列表不显示」。
        Keyboard.dismiss();
        try {
            const result = await plugin.methods.search(q, 1, "music");
            const data = (result?.data ?? []) as IMusic.IMusicItem[];
            setResults(data);
            if (data.length === 0) {
                Toast.warn(`未在「${plugin.name}」找到「${q}」`);
            } else {
                Toast.success(`找到 ${data.length} 个结果`);
            }
        } catch (e: any) {
            setResults([]);
            Toast.warn(`搜索失败：${e?.message ?? e}`);
        } finally {
            setLoading(false);
            // 键盘弹起时面板会压缩到只显示搜索框（列表整块隐藏），
            // 搜完必须收起键盘，否则用户看到「结果出来了但列表不显示」。
            Keyboard.dismiss();
        }
    }

    // 替换成功后，清理原歌曲的下载文件与缓存
    async function removeOriginalLocalResources() {
        try {
            // 1. 删除下载目录中的原歌曲文件（含回退扫描：歌名@作者匹配）
            const localPath = await getLocalPathWithFallback(musicItem);
            if (localPath) {
                try {
                    await unlink(localPath);
                } catch {
                    /* 文件可能已不存在 */
                }
            }
        } catch {
            /* 忽略 */
        }
        try {
            // 2. 取消/移除下载队列中该歌曲的任务
            Downloader.remove(musicItem);
            // 3. 下载目录文件有变动，失效索引
            invalidateDownloadDirCache();
        } catch {
            /* 忽略 */
        }
        try {
            // 4. 删除原歌曲的缓存（mediaCache MMKV 中的 metadata）
            MediaCache.removeMediaCache(musicItem);
        } catch {
            /* 忽略 */
        }
    }

    async function onResultPress(result: IMusic.IMusicItem) {
        try {
            if (musicSheet) {
                const ok = await MusicSheet.replaceMusic(
                    musicSheet.id,
                    musicItem,
                    result,
                );
                if (ok) {
                    // 换源成功后清理原歌曲的本地下载文件与缓存
                    await removeOriginalLocalResources();
                    Toast.success(`已换源为「${result.platform}」版本`);
                } else {
                    Toast.warn("未在当前歌单中找到原歌曲");
                }
            } else {
                // 不在歌单中（如搜索结果），直接播放其他源
                TrackPlayer.play(result);
                Toast.success(`已播放「${result.platform}」版本`);
            }
            hidePanel();
        } catch (e: any) {
            Toast.warn(`${e?.message ?? e}`);
        }
    }

    // 点击整行：先试听（播放该结果，不替换歌单、不下载文件）
    async function onPreviewPress(result: IMusic.IMusicItem) {
        try {
            await TrackPlayer.play(result, true, false);
            Toast.success(`试听中：${result.title}`);
        } catch (e: any) {
            Toast.warn(`试听失败：${e?.message ?? e}`);
        }
    }

    // 第一步：选择插件
    // 双层 flex：最外层 View(flex:1) 作为 PanelBase body 唯一子节点拿满高度，
    // 内部列表容器再 flex:1 撑开剩余空间（避免多兄弟节点下 flex 高度塌缩为 0）
    if (!selectedPlugin) {
        return (
            <PanelBase
                renderBody={() => (
                    <View style={globalStyle.flex1}>
                        <PanelHeader title="换源" hideButtons />
                        <View style={globalStyle.flex1}>
                            <FlatList
                                data={plugins}
                                keyExtractor={_ => _.hash}
                                style={{
                                    marginBottom: safeAreaInsets.bottom,
                                }}
                                renderItem={({ item }) => (
                                    <ListItem
                                        withHorizontalPadding
                                        heightType="small"
                                        onPress={() => setSelectedPlugin(item)}>
                                        <ListItem.ListItemIcon
                                            width={rpx(48)}
                                            icon="musical-note"
                                            iconSize={iconSizeConst.light}
                                        />
                                        <ListItem.Content
                                            title={item.name}
                                            description={`来源：${item.instance.platform}`}
                                        />
                                    </ListItem>
                                )}
                                ListEmptyComponent={
                                    <ThemeText
                                        style={style.empty}
                                        fontColor="textSecondary">
                                        系统中没有已安装且支持搜索的插件
                                    </ThemeText>
                                }
                            />
                        </View>
                    </View>
                )}
            />
        );
    }

    // 第二步：搜索结果
    // 顶部固定两行搜索框（歌名/作者），列表区双层 flex + minHeight 兜底
    // 键盘处理：Manifest 已设 adjustResize（系统自动缩窗），必须 keyboardAvoidBehavior="none"
    // 避免 KeyboardAvoidingView 双重位移；键盘弹起时压缩面板高度到只显示搜索框，
    // 保证输入框在键盘上方且不出屏，键盘收起后恢复全高显示列表
    return (
        <PanelBase
            height={keyboardVisible ? rpx(330) : vh(80)}
            keyboardAvoidBehavior="none"
            renderBody={() => (
                <View style={globalStyle.flex1}>
                    <PanelHeader
                        title={`换源 · ${selectedPlugin.name}`}
                        cancelText="返回"
                        onCancel={() => {
                            setSelectedPlugin(null);
                            setResults([]);
                            setSearched(false);
                        }}
                        hideDivider
                    />
                    {/* 固定高度搜索区：歌名 + 作者，两行 */}
                    <View style={style.searchBox}>
                        <View
                            style={[
                                style.searchRow,
                                { backgroundColor: colors.placeholder },
                            ]}>
                            <ListItem.ListItemIcon
                                width={rpx(40)}
                                icon="musical-note"
                                iconSize={iconSizeConst.light}
                            />
                            <TextInput
                                style={[style.input, { color: colors.text }]}
                                value={titleKw}
                                placeholder="歌曲名"
                                placeholderTextColor={colors.textSecondary}
                                onChangeText={setTitleKw}
                                onSubmitEditing={() =>
                                    doSearch(selectedPlugin)
                                }
                                returnKeyType="search"
                            />
                        </View>
                        <View
                            style={[
                                style.searchRow,
                                { backgroundColor: colors.placeholder },
                            ]}>
                            <ListItem.ListItemIcon
                                width={rpx(40)}
                                icon="user"
                                iconSize={iconSizeConst.light}
                            />
                            <TextInput
                                style={[style.input, { color: colors.text }]}
                                value={artistKw}
                                placeholder="作者"
                                placeholderTextColor={colors.textSecondary}
                                onChangeText={setArtistKw}
                                onSubmitEditing={() =>
                                    doSearch(selectedPlugin)
                                }
                                returnKeyType="search"
                            />
                            <Pressable
                                style={style.searchBtn}
                                onPress={() => doSearch(selectedPlugin)}>
                                <ListItem.ListItemIcon
                                    width={rpx(56)}
                                    icon="magnifying-glass"
                                    iconSize={iconSizeConst.light}
                                />
                            </Pressable>
                        </View>
                    </View>
                    {keyboardVisible ? null : (
                        <>
                            <Divider />
                            <View style={style.listWrapper}>
                                <FlatList
                                    data={results}
                                    keyExtractor={item =>
                                        `${item.platform}-${item.id}`
                                    }
                                    style={{
                                        marginBottom: safeAreaInsets.bottom,
                                    }}
                                    renderItem={({ item }) => (
                                        <ListItem
                                            withHorizontalPadding
                                            heightType="small"
                                            onPress={() =>
                                                onPreviewPress(item)
                                            }>
                                            <ListItem.ListItemIcon
                                                width={rpx(48)}
                                                icon="musical-note"
                                                iconSize={iconSizeConst.light}
                                            />
                                            <ListItem.Content
                                                title={`${item.title}（${item.platform}）`}
                                                description={
                                                    item.artist
                                                        ? `${item.artist}${
                                                              item.album
                                                                  ? ` - ${item.album}`
                                                                  : ""
                                                          }`
                                                        : ""
                                                }
                                            />
                                            <ListItem.ListItemIcon
                                                width={rpx(88)}
                                                position="right"
                                                icon="arrows-left-right"
                                                iconSize={iconSizeConst.normal}
                                                onPress={() =>
                                                    onResultPress(item)
                                                }
                                                hitSlop={8}
                                            />
                                        </ListItem>
                                    )}
                                    ListEmptyComponent={
                                        !loading &&
                                        searched &&
                                        results.length === 0 ? (
                                            <ThemeText
                                                style={style.empty}
                                                fontColor="textSecondary">
                                                未在「{selectedPlugin.name}」
                                                找到匹配结果
                                            </ThemeText>
                                        ) : null
                                    }
                                />
                            </View>
                        </>
                    )}
                </View>
            )}
        />
    );
}

const style = StyleSheet.create({
    empty: {
        paddingHorizontal: rpx(48),
        paddingTop: rpx(60),
        textAlign: "center",
    },
    // 搜索区：固定高度，flexShrink:0（不能参与 flex 分配，否则会挤塌列表区）
    searchBox: {
        flexShrink: 0,
        paddingHorizontal: rpx(20),
        paddingVertical: rpx(10),
        gap: rpx(10),
    },
    searchRow: {
        height: rpx(76),
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#00000010",
        borderRadius: rpx(12),
        paddingHorizontal: rpx(12),
    },
    input: {
        flex: 1,
        height: rpx(76),
        fontSize: rpx(26),
    },
    searchBtn: {
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: rpx(8),
    },
    listWrapper: {
        flex: 1,
        // 兜底：即使 flex 分配失效，也保证列表容器有可显示高度
        minHeight: rpx(400),
    },
});
