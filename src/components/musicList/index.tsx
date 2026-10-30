import { RequestStateCode } from "@/constants/commonConst";
import TrackPlayer from "@/core/trackPlayer";
import rpx from "@/utils/rpx";
import { FlashList } from "@shopify/flash-list";
import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import {
    ActivityIndicator,
    FlatListProps,
    Pressable,
    StyleSheet,
    View,
} from "react-native";
import { appendFile, ExternalDirectoryPath } from "react-native-fs";

/**
 * 定位耗时探针：把「点击 → 新列表首帧 → 切换完成」的耗时写到
 * `Android/data/fun.upup.musicfree/files/jump_probe.log`。
 * release 包的 console.log 不进 logcat，只能落盘 + `adb shell cat` 读回来。
 * 平时关掉（零开销）；怀疑定位慢/跳转异常时改成 true 再编一版即可。
 *
 * 实测（528 首歌单，从第 1 行跳到第 340 行）：
 * - 小米15  Android 16：onLoad +154ms，commit +163ms
 * - 小米10 Pro Android 14：onLoad +306ms，commit +313ms
 * 也就是说耗时几乎全在「新列表挂载 + 首个 cell 布局」，切换本身只占几毫秒。
 */
const JUMP_PROBE = false;
const JUMP_PROBE_FILE = `${ExternalDirectoryPath}/jump_probe.log`;
function jumpProbe(msg: string) {
    if (!JUMP_PROBE) {
        return;
    }
    appendFile(JUMP_PROBE_FILE, `${Date.now()} ${msg}\n`, "utf8").catch(
        () => {},
    );
}
import ListEmpty from "../base/listEmpty";
import ListFooter from "../base/listFooter";
import MusicItem from "../mediaItem/musicItem";
import { isSameMediaItem } from "@/utils/mediaUtils";
import Icon from "../base/icon";
import { iconSizeConst, musicListItemHeight } from "@/constants/uiConst";
import useColors from "@/hooks/useColors";

interface IMusicListProps {
    /** 顶部 */
    Header?: FlatListProps<IMusic.IMusicItem>["ListHeaderComponent"];
    /** 音乐列表 */
    musicList?: IMusic.IMusicItem[];
    /** 所在歌单 */
    musicSheet?: IMusic.IMusicSheetItem;
    /** 是否展示序号 */
    showIndex?: boolean;
    /** 点击 */
    onItemPress?: (
        musicItem: IMusic.IMusicItem,
        musicList?: IMusic.IMusicItem[],
    ) => void;
    // 状态
    state: RequestStateCode;
    /** 高亮的音乐 */
    highlightMusicItem?: IMusic.IMusicItem | null;
    /** 挂载后自动滚动定位到高亮音乐（仅一次，用于启动恢复） */
    autoScrollToHighlight?: boolean;
    /** 切歌时自动滑动到正在播放的歌曲（默认开启） */
    followCurrent?: boolean;
    /** 外部触发回到第一条：传入一个自增的信号值（每次变化滚到顶部） */
    scrollToTopSignal?: number;
    onRetry?: () => void;
    onLoadMore?: () => void;
}
/**
 * 单行高度：必须和 mediaItem/musicItem 的 compactRow 一致。
 * 定位偏移是「时高 × 索引」算出来的，不一致会让索引大的行偏得离谱
 * （点定位按钮跑偏、点歌时误判不在屏幕内而自动滚动）。
 */
const ITEM_HEIGHT = musicListItemHeight;

/** 一个列表实例：initialScrollIndex + 唯一 key（key 变即重新挂载） */
interface IListInstance {
    index: number;
    key: number;
}

/** 音乐列表 */
export default function MusicList(props: IMusicListProps) {
    const {
        Header,
        musicList,
        musicSheet,
        showIndex,
        onItemPress,
        state,
        onRetry,
        onLoadMore,
        highlightMusicItem,
        autoScrollToHighlight,
        followCurrent = true,
        scrollToTopSignal,
    } = props;
    const colors = useColors();
    const flashListRef = useRef<FlashList<IMusic.IMusicItem>>(null);
    const [showBadge, setShowBadge] = useState(false);
    const hideTimeoutRef = useRef<NodeJS.Timeout>();

    /** 列表可视区域高度（用于把目标项滚动到中间） */
    const listHeightRef = useRef(0);
    /** 列表真实尺寸（交给 FlashList 作为 estimatedListSize，保证首帧布局与触摸一致） */
    const [listSize, setListSize] = useState<{
        width: number;
        height: number;
    } | null>(null);
    /** 列表头部高度（滚动偏移要带上它） */
    const headerHeightRef = useRef(0);
    /** 用户是否正在手动拖动列表（此时不打断用户） */
    const isDraggingRef = useRef(false);
    /** 当前滚动偏移（用于判断目标项是否已在屏幕内） */
    const scrollOffsetRef = useRef(0);
    /**
     * 用户主动点了列表里的某一行时，在此时刻之前不要自动跟随滚动。
     * 点歌本身就是「我看到它、我点它」，列表再自己动一下会让人点错下一首。
     * 用时间窗而不是布尔标记：同一首歌重复点击不会产生高亮变化，
     * 布尔标记会残留下来，把下一次真正的切歌跟随吃掉。
     */
    const suppressFollowUntilRef = useRef(0);

    // 查找高亮项的索引
    const highlightIndex = React.useMemo(() => {
        if (!highlightMusicItem || !musicList) return -1;
        return musicList.findIndex(item => isSameMediaItem(item, highlightMusicItem));
    }, [highlightMusicItem, musicList]);    
    
    // 处理滚动开始
    const handleScrollBegin = useCallback(() => {
        isDraggingRef.current = true;
        if (highlightIndex !== -1) {
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
            setShowBadge(true);
        }
    }, [highlightIndex]);
    
    // 处理滚动结束
    const handleScrollEnd = useCallback(() => {
        isDraggingRef.current = false;
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
        }
        // 5秒后直接隐藏
        hideTimeoutRef.current = setTimeout(() => {
            setShowBadge(false);
        }, 5000);
    }, []);    
    
    /**
     * 跳到某一项（并让它落在列表中间）。
     *
     * 这里**不用滚动接口**，而是换 key 让 FlashList 重新挂载、用
     * `initialScrollIndex` 由首帧布局直接摆好位置。
     *
     * 原因：任何「挂载之后再程序化滚动」（scrollToOffset / FlashList.scrollToIndex /
     * 底层 RecyclerListView.scrollToIndex 都试过）之后，列表画面是对的，但 cell
     * 的点击会全部失效，必须手指上下滑一下才恢复 —— 这是 native 层的滚动状态残留，
     * JS 侧无法修补（试过 1px 偏移往返、removeClippedSubviews、重算命中区，都无效）。
     * 而 `initialScrollIndex` 是挂在 ScrollView 首帧的初始 contentOffset 上，
     * 不产生「滚动」这个动作，冷启动场景已验证点得动。
     *
     * 居中做法：initialScrollIndex 只能把目标行顶到视口顶部，所以把起始索引
     * 往前挪「半屏的行数」，让目标行落在中间（误差不超过半行）。
     */
    const jumpKeyRef = useRef(0);
    /** 最近一次跳转的时间戳（探针用） */
    const jumpAtRef = useRef(0);

    /**
     * 双缓冲渲染：a / b 两个槽位，同一时刻只有一个可见。
     *
     * 为什么不是「一个列表换 key 重挂载」：FlashList 挂载后的第一个渲染周期**不绘制 cell**
     * （官方 onLoad 注释原话："FlashList doesn't render items in the first cycle"），
     * 而 initialScrollIndex 的实现是「先把渲染窗口摆到第 N 项，再把 ScrollView 滚过去」，
     * 中间那一帧视口停在内容顶部 —— 用户看到的就是「点定位 → 画面空白一下 → 才定位到歌曲」。
     *
     * 所以跳转改成：新列表在**另一个槽位隐藏挂载**（屏幕上看不见），等它首帧画好
     * （onLoad + 两帧）再把可见槽位切过去、同时卸载旧槽位。旧列表全程原地不动，
     * 因此不会被 React 重建、也不会自己空白一次。
     */
    const [slotA, setSlotA] = useState<IListInstance | null>({
        index: -1,
        key: 0,
    });
    const [slotB, setSlotB] = useState<IListInstance | null>(null);
    /** 当前可见的槽位 */
    const [visibleSlot, setVisibleSlot] = useState<"a" | "b">("a");
    /** 正在等首帧的槽位（null = 没有跳转在进行） */
    const [pendingSlot, setPendingSlot] = useState<"a" | "b" | null>(null);
    /** 上面四个 state 的镜像：setState 是异步的，回调里要读最新值 */
    const slotsRef = useRef({ slotA, slotB, visibleSlot, pendingSlot });
    slotsRef.current = { slotA, slotB, visibleSlot, pendingSlot };

    /**
     * 行高实测值。
     *
     * 常量 `ITEM_HEIGHT` 只是样式里声明的值，实际行高会比它高一截
     * （ListItem 自带内边距 + 行间距），不同机型/方向都不一样。
     * 「挪半屏该挪几行」如果按常量算，偏差会被放大成小半屏，
     * 所以这里让第一行渲染后把真实高度量出来。
     */
    const rowHeightRef = useRef(ITEM_HEIGHT);

    const jumpToIndex = useCallback((index: number) => {
        if (index < 0) {
            return;
        }
        const viewport = listHeightRef.current;
        const rowHeight = rowHeightRef.current > 0 ? rowHeightRef.current : ITEM_HEIGHT;
        const rowsAbove =
            viewport > 0
                ? Math.max(
                      0,
                      Math.round((viewport / 2 - rowHeight / 2) / rowHeight),
                  )
                : 0;
        const start = Math.max(0, index - rowsAbove);
        // FlashList 的 initialScrollIndex 会把表头高度重复折算一次
        // （探针实测：传 322 时顶部实际落在 318，差的正好是 ListHeader 占的行数），
        // 所以把表头行数补回去，目标行才会真正落到中间。
        const headerRows =
            rowHeight > 0
                ? Math.round(headerHeightRef.current / rowHeight)
                : 0;
        const scrollIndex = Math.max(0, start + headerRows);
        // 重挂载后 onScroll 要等首帧回调，先把偏移估一个值，
        // 避免「切歌跟随」的可视判断拿到旧偏移再跳一次
        scrollOffsetRef.current = start * rowHeight;
        const next: IListInstance = {
            index: scrollIndex,
            key: jumpKeyRef.current + 1,
        };
        jumpKeyRef.current = next.key;
        jumpAtRef.current = Date.now();
        jumpProbe(`A jump idx=${scrollIndex}`);
        // 新列表挂到「当前不可见」的那个槽位；已有一个在等首帧时直接替换它
        // （它本来就藏着，换 key 重挂也看不见）
        const st = slotsRef.current;
        const target: "a" | "b" = st.pendingSlot
            ? st.pendingSlot
            : st.visibleSlot === "a"
            ? "b"
            : "a";
        if (target === "a") {
            setSlotA(next);
        } else {
            setSlotB(next);
        }
        setPendingSlot(target);
    }, []);

    /**
     * 把可见槽位切到 slot，并卸载另一个槽位。
     * 旧列表要等新列表「画好内容」才撤，否则那一帧空白会露出来。
     */
    const commitSlot = useCallback((slot: "a" | "b") => {
        // 等首帧的这几帧里可能又来了一次跳转（pending 被替换到同一槽位），
        // 那种情况下这次 commit 已经过期，不能切
        if (slotsRef.current.pendingSlot !== slot) {
            return;
        }
        jumpProbe(`C commit +${Date.now() - jumpAtRef.current} slot=${slot}`);
        setVisibleSlot(slot);
        setPendingSlot(null);
        // 另一个槽位已经看不见了，留着一份虚拟化 cell 只是白占内存，
        // 但**不能和切可见放在同一帧**：销毁一整个原生列表会抢在切换帧之前
        // 执行，让「列表出现」晚一帧甚至几帧。推迟到下一帧再拆。
        const other: "a" | "b" = slot === "a" ? "b" : "a";
        const otherKey = (other === "a" ? slotsRef.current.slotA : slotsRef.current.slotB)?.key;
        requestAnimationFrame(() => {
            const st = slotsRef.current;
            // 这一帧里可能又发生了一次跳转、刚把新列表挂到 other 上，别误伤
            if (st.pendingSlot === other) {
                return;
            }
            const cur = other === "a" ? st.slotA : st.slotB;
            if (!cur || (otherKey !== undefined && cur.key !== otherKey)) {
                return;
            }
            if (other === "a") {
                setSlotA(null);
            } else {
                setSlotB(null);
            }
        });
    }, []);

    /**
     * 新列表首帧画好了（onLoad 由首个子项布局触发，此时内容已经在屏幕上）。
     * 只等一帧让 initialScrollIndex 的偏移落位，不再叠 32ms 延时 ——
     * 之前那两帧 + 32ms 是纯感知延迟，实测内容在 onLoad 时就已就位。
     */
    const handleSlotLoad = useCallback(
        (slot: "a" | "b", key: number) => {
            const st = slotsRef.current;
            // 已经不是「等这个槽位」了（或它已被下一次跳转替换）→ 忽略
            if (st.pendingSlot !== slot) {
                return;
            }
            const inst = slot === "a" ? st.slotA : st.slotB;
            if (!inst || inst.key !== key) {
                return;
            }
            jumpProbe(`B onLoad +${Date.now() - jumpAtRef.current}`);
            requestAnimationFrame(() => commitSlot(slot));
        },
        [commitSlot],
    );

    // 兜底：空列表等情况下 onLoad 不会触发，不能一直等着不切
    useEffect(() => {
        if (!pendingSlot) {
            return;
        }
        const timer = setTimeout(() => {
            if (slotsRef.current.pendingSlot !== pendingSlot) {
                return;
            }
            jumpProbe(`F fallback +${Date.now() - jumpAtRef.current}`);
            commitSlot(pendingSlot);
        }, 700);
        return () => clearTimeout(timer);
    }, [pendingSlot, slotA?.key, slotB?.key, commitSlot]);
    
    // 滚动到高亮项（点「定位到正在播放」按钮）
    const scrollToHighlight = useCallback(() => {
        if (highlightIndex !== -1) {
            jumpToIndex(highlightIndex);
            // 立即隐藏角标
            setShowBadge(false);
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
        }
    }, [highlightIndex, jumpToIndex]);    
    
    // 清理定时器
    useEffect(() => {
        return () => {
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
        };
    }, []);

    /**
     * 启动定位用的初始索引：FlashList 只在挂载时读一次 initialScrollIndex，
     * 由它在首帧布局里直接把目标行摆到正确位置 —— 不走「挂载后再滚」那条路，
     * 避免程序化滚动带来的「列表画对了但点不动」问题。
     * 这里用 ref 快照一次，之后切歌不再影响它。
     */
    const initialIndexRef = useRef<number | undefined>(undefined);
    if (
        initialIndexRef.current === undefined &&
        autoScrollToHighlight &&
        highlightIndex >= 0
    ) {
        initialIndexRef.current = highlightIndex;
    }
    /** 启动定位期间等当前播放的歌曲信息到手再挂载列表，否则拿不到初始索引 */
    const [initWaitDone, setInitWaitDone] = useState(false);
    useEffect(() => {
        if (!autoScrollToHighlight || highlightMusicItem) {
            return;
        }
        // 兜底：当前没有播放中的歌曲时不能一直等下去
        const timer = setTimeout(() => setInitWaitDone(true), 800);
        return () => clearTimeout(timer);
    }, [autoScrollToHighlight, highlightMusicItem]);
    const waitForInitialPosition =
        !!autoScrollToHighlight && !highlightMusicItem && !initWaitDone;

    // 切换歌单（歌单 id 变化）时回到顶部；首次挂载不触发，避免与启动定位冲突
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        if (autoScrollToHighlight) {
            return;
        }
        // 用重挂载回到顶部（理由同 jumpToIndex：滚动接口会留下点不动的状态）
        jumpToIndex(0);
    }, [musicSheet?.id, autoScrollToHighlight, jumpToIndex]);

    // 切歌跟随：正在播放的歌曲变化时自动滑动到它（切歌 / 上一首 / 下一首 /
    // 随机播放跳转都会触发）。用户正在手动拖动列表时不打断；
    // 目标项如果本来就在屏幕内（例如点列表里的歌、按下一首）就不做无意义的滚动。
    // 首次渲染不处理 —— 启动定位由 autoScrollToHighlight 负责。
    const firstHighlightRunRef = useRef(true);
    const prevHighlightIndexRef = useRef(-1);
    useEffect(() => {
        const changed = prevHighlightIndexRef.current !== highlightIndex;
        prevHighlightIndexRef.current = highlightIndex;
        if (firstHighlightRunRef.current) {
            firstHighlightRunRef.current = false;
            return;
        }
        if (!followCurrent || !changed || highlightIndex === -1) {
            return;
        }
        if (isDraggingRef.current) {
            return;
        }
        // 刚点过行（点歌 / 点了别的行）：不要跟着动，用户视线就在那一行
        if (Date.now() < suppressFollowUntilRef.current) {
            return;
        }
        // 已完整显示在可视区内 → 不滚动，避免列表自己跳动
        const viewport = listHeightRef.current;
        const rowHeight =
            rowHeightRef.current > 0 ? rowHeightRef.current : ITEM_HEIGHT;
        const top =
            headerHeightRef.current +
            highlightIndex * rowHeight -
            scrollOffsetRef.current;
        const bottom = top + rowHeight;
        if (viewport > 0 && top >= 0 && bottom <= viewport) {
            return;
        }
        // 等这一帧渲染完再跳，保证新行已经布局
        const timer = setTimeout(() => {
            jumpToIndex(highlightIndex);
        }, 120);
        return () => clearTimeout(timer);
    }, [highlightIndex, followCurrent, jumpToIndex]);

    // 外部触发回到第一条（如长按歌单标题）
    const prevScrollToTopSignalRef = useRef(scrollToTopSignal);
    useEffect(() => {
        if (scrollToTopSignal === undefined) {
            return;
        }
        if (prevScrollToTopSignalRef.current === scrollToTopSignal) {
            return;
        }
        prevScrollToTopSignalRef.current = scrollToTopSignal;
        jumpToIndex(0);
    }, [scrollToTopSignal, jumpToIndex]);

    /**
     * 渲染一个列表实例。
     *
     * 同一时刻最多两个：可见的（active）和隐藏着的「下一个」（等它 onLoad 再切过来）。
     * 隐藏那个不接滚动/加载更多回调，避免两边同时改共享 ref；
     * 但必须接 onLoad —— 那正是「画好了可以切」的信号。
     */
    const renderFlashList = (
        inst: IListInstance,
        slot: "a" | "b",
        active: boolean,
    ) => (
        <FlashList
            // key 取「宽度 + 跳转序号」：
            // 宽度变化（分屏/旋转）必须重挂，宽度为 0 时挂载会让 cell 点不动；
            // 跳转（定位按钮 / 切歌跟随 / 回顶部）也靠换 key 重挂，
            // 由 initialScrollIndex 在首帧摆好位置，不走滚动接口。
            key={`w${Math.round(listSize!.width)}-j${inst.key}`}
            ref={active ? flashListRef : undefined}
            estimatedListSize={listSize!}
            // 定位：交给首帧布局直接摆好，不做事后滚动
            initialScrollIndex={
                inst.index >= 0
                    ? Math.min(
                          inst.index,
                          Math.max(0, (musicList?.length ?? 1) - 1),
                      )
                    : initialIndexRef.current
            }
            // 关闭子视图裁剪：Android 上它会在程序化滚动 / 尺寸变化后
            // 把 cell 从原生视图树里摘掉，表现为「列表看得见但点不动，
            // 手指滑一下才恢复」。列表本身有虚拟化，不裁剪也不会多渲染。
            removeClippedSubviews={false}
            // 首帧画出内容 → 可以切到这个槽位了
            onLoad={() => handleSlotLoad(slot, inst.key)}
            ListHeaderComponent={
                Header ? (
                    // 包一层只为量出头高度，滚动定位时要把它算进偏移
                    <View
                        onLayout={e => {
                            headerHeightRef.current =
                                e.nativeEvent.layout.height;
                        }}>
                        {Header as React.ReactNode}
                    </View>
                ) : null
            }
            ListEmptyComponent={<ListEmpty state={state} onRetry={onRetry} />}
            ListFooterComponent={
                musicList?.length ? <ListFooter state={state} onRetry={onRetry} /> : null
            }
            extraData={highlightMusicItem}
            data={musicList ?? []}
            estimatedItemSize={ITEM_HEIGHT}
            // 声明每行真实高度：让内部偏移计算 / 可视判断与真实布局一致，
            // 避免长列表里「时高 × 索引」的估算误差累积
            overrideItemLayout={layout => {
                layout.size = ITEM_HEIGHT;
            }}
            onScrollBeginDrag={active ? handleScrollBegin : undefined}
            onScrollEndDrag={active ? handleScrollEnd : undefined}
            onMomentumScrollEnd={active ? handleScrollEnd : undefined}
            onScroll={
                active
                    ? e => {
                          scrollOffsetRef.current =
                              e.nativeEvent.contentOffset.y;
                      }
                    : undefined
            }
            scrollEventThrottle={32}
            renderItem={({ index, item: musicItem }) => {
                return (
                    // 包一层只为量出真实行高（定位居中要用），
                    // 普通 View 不参与触摸响应，不影响行内点击
                    <View
                        onLayout={e => {
                            const h = e.nativeEvent.layout.height;
                            if (h > 0) {
                                rowHeightRef.current = h;
                            }
                        }}>
                        <MusicItem
                            musicItem={musicItem}
                            index={showIndex ? index + 1 : undefined}
                            onItemPress={() => {
                                // 用户点的是「眼前这一行」，播放后列表不要自己滑动
                                suppressFollowUntilRef.current =
                                    Date.now() + 2000;
                                if (onItemPress) {
                                    onItemPress(musicItem, musicList);
                                } else {
                                    TrackPlayer.playWithReplacePlayList(
                                        musicItem,
                                        musicList ?? [musicItem],
                                    );
                                }
                            }}
                            musicSheet={musicSheet}
                            highlight={isSameMediaItem(
                                musicItem,
                                highlightMusicItem,
                            )}
                        />
                    </View>
                );
            }}
            onEndReached={
                active
                    ? () => {
                          if (
                              state === RequestStateCode.IDLE ||
                              state === RequestStateCode.PARTLY_DONE
                          ) {
                              onLoadMore?.();
                          }
                      }
                    : undefined
            }
            onEndReachedThreshold={0.1}
        />
    );

    return (
        <View
            style={styles.container}
            onLayout={e => {
                const { height, width } = e.nativeEvent.layout;
                listHeightRef.current = height;
                // 拿到真实尺寸后把它交给 FlashList（estimatedListSize）：
                // 首帧按估算尺寸布局时，行位置与触摸命中区可能不一致，
                // 表现为「刚进页面点列表没反应，滑动一下才正常」。
                setListSize(prev =>
                    prev && prev.height === height && prev.width === width
                        ? prev
                        : { width, height },
                );
            }}>
            {/* 等容器量出真实宽高再挂载 FlashList：
                横屏分屏刚进页面时父容器尺寸还是 0，列表若此时挂载，
                RecyclerListView 会按 0 宽布局 cell，之后尺寸更新也不会重算
                触摸命中区 —— 表现为「整块列表点不动，上下滑一下才恢复」。
                用宽高做 key，旋转/分屏切换导致尺寸变化时也会重新挂载一次。 */}
            {listSize &&
            listSize.width > 0 &&
            listSize.height > 0 &&
            !waitForInitialPosition ? (
                <>
                    {/* A 槽：一直存在；跳转时新列表挂到空着的那个槽位并先隐藏，
                        画好内容后再把可见槽位切过去，所以屏幕上不会出现空白帧 */}
                    {slotA ? (
                        <View
                            key="slotA"
                            style={[
                                styles.listLayer,
                                visibleSlot !== "a" && styles.listHidden,
                            ]}
                            pointerEvents={visibleSlot === "a" ? "auto" : "none"}>
                            {renderFlashList(slotA, "a", visibleSlot === "a")}
                        </View>
                    ) : null}
                    {slotB ? (
                        <View
                            key="slotB"
                            style={[
                                styles.listLayer,
                                visibleSlot !== "b" && styles.listHidden,
                            ]}
                            pointerEvents={visibleSlot === "b" ? "auto" : "none"}>
                            {renderFlashList(slotB, "b", visibleSlot === "b")}
                        </View>
                    ) : null}
                </>
            ) : null}
            {(showBadge || pendingSlot !== null) && (
                <View style={styles.badge} pointerEvents="box-none">
                    <Pressable
                        style={[styles.badgeButton, { backgroundColor: colors.notification }]}
                        onPress={scrollToHighlight}
                        disabled={pendingSlot !== null}
                    >
                        {/* 跳转要等新列表画好才切，这段时间给个转圈，
                            否则按下去到画面变化之间完全没反馈，像卡住了 */}
                        {pendingSlot !== null ? (
                            <ActivityIndicator size="small" color={colors.text} />
                        ) : (
                            <Icon
                                name="crosshair"
                                size={iconSizeConst.normal}
                                color={colors.text}
                            />
                        )}
                    </Pressable>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    /** 两个槽位叠在同一块区域上，只靠 opacity 切换可见性 */
    listLayer: {
        ...StyleSheet.absoluteFillObject,
    },
    /** 新列表内容画出来之前先藏住，由旧列表顶住画面 */
    listHidden: {
        opacity: 0,
    },
    badge: {
        position: "absolute",
        bottom: rpx(80),
        right: rpx(84),
        zIndex: 1000,
    },
    badgeButton: {
        width: rpx(64),
        height: rpx(64),
        borderRadius: rpx(32),
        justifyContent: "center",
        alignItems: "center",
        shadowColor: "#000",
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
    },
});
