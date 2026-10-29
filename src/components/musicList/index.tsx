import { RequestStateCode } from "@/constants/commonConst";
import TrackPlayer from "@/core/trackPlayer";
import rpx from "@/utils/rpx";
import { FlashList } from "@shopify/flash-list";
import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import {
    FlatListProps,
    Pressable,
    StyleSheet,
    View,
} from "react-native";
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
    
    // 把某一项滚到列表正中
    //
    // 两条路径：
    // ① 目标已渲染（FlashList 能拿到它的真实布局）→ scrollToIndex + viewPosition 0.5，
    //    由列表自己算偏移，像素级正中；
    // ② 目标在远处（没渲染过，FlashList 的 scrollToIndex 直接静默返回，因为
    //    getLayout 拿不到布局）→ 交给底层 RecyclerListView 的 scrollToIndex，
    //    它按布局管理器里的累加尺寸算偏移，多远都能跳；跳完再精调一次居中。
    const scrollIndexToCenter = useCallback(
        (index: number, animated: boolean) => {
            const list = flashListRef.current;
            if (!list || index < 0) {
                return;
            }
            const rlv = (list as any).recyclerlistview_unsafe as
                | {
                      getLayout?: (i: number) => { y: number } | undefined;
                      scrollToIndex?: (i: number, animate?: boolean) => void;
                  }
                | undefined;
            // ① 已渲染：直接按真实布局居中
            if (rlv?.getLayout?.(index)) {
                try {
                    list.scrollToIndex({
                        index,
                        viewPosition: 0.5,
                        animated,
                    });
                    return;
                } catch (e) {
                    // 落到下面的兜底逻辑
                }
            }
            // ② 远处：先让 RLV 跳到该项（O(1) 不渲染中间项），再精调
            if (rlv?.scrollToIndex) {
                try {
                    rlv.scrollToIndex(index, animated);
                    setTimeout(
                        () => {
                            try {
                                flashListRef.current?.scrollToIndex({
                                    index,
                                    viewPosition: 0.5,
                                    animated: false,
                                });
                            } catch (e) {
                                // 目标还没渲染出来时保持 RLV 算出的位置
                            }
                        },
                        animated ? 320 : 200,
                    );
                    return;
                } catch (e) {
                    // 落到下面的兜底逻辑
                }
            }
            // 兜底：按「行高 × 索引」估算
            const viewport = listHeightRef.current;
            const offsetInList = headerHeightRef.current + index * ITEM_HEIGHT;
            const targetOffset = Math.max(
                0,
                offsetInList - Math.max(0, (viewport - ITEM_HEIGHT) / 2),
            );
            try {
                list.scrollToOffset({ offset: targetOffset, animated: false });
            } catch (e) {
                // 列表尚未完成布局，忽略
            }
        },
        [],
    );
    
    // 滚动到高亮项（点「定位到正在播放」按钮）
    const scrollToHighlight = useCallback(() => {
        if (highlightIndex !== -1 && flashListRef.current) {
            // 带动画滚到正中，视觉上能看出「跳到了哪里」
            scrollIndexToCenter(highlightIndex, true);
            // 立即隐藏角标
            setShowBadge(false);
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
        }
    }, [highlightIndex, scrollIndexToCenter]);    
    
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
        const list = flashListRef.current;
        if (!list) {
            return;
        }
        try {
            list.scrollToOffset({ offset: 0, animated: false });
        } catch (e) {
            // 列表尚未完成布局，忽略
        }
    }, [musicSheet?.id, autoScrollToHighlight]);

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
        const top =
            headerHeightRef.current +
            highlightIndex * ITEM_HEIGHT -
            scrollOffsetRef.current;
        const bottom = top + ITEM_HEIGHT;
        if (viewport > 0 && top >= 0 && bottom <= viewport) {
            return;
        }
        // 等这一帧渲染完再滚，保证新行已经布局、偏移算得准
        const timer = setTimeout(() => {
            scrollIndexToCenter(highlightIndex, true);
        }, 120);
        return () => clearTimeout(timer);
    }, [highlightIndex, followCurrent, scrollIndexToCenter]);

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
        const list = flashListRef.current;
        if (!list) {
            return;
        }
        try {
            list.scrollToOffset({ offset: 0, animated: true });
        } catch (e) {
            // 列表尚未完成布局，忽略
        }
    }, [scrollToTopSignal]);

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
            <FlashList
                // key 只取「宽度」：分屏/旋转导致宽度变化时才重新挂载
                // （宽度为 0 时挂载会让 cell 的触摸命中区失效）。
                // 高度变化（如键盘弹起）不能触发重挂，否则列表会被重置回顶部。
                key={`w${Math.round(listSize.width)}`}
                ref={flashListRef}
                estimatedListSize={listSize}
                // 启动定位：交给首帧布局直接摆好，不做事后滚动
                initialScrollIndex={initialIndexRef.current}
                // 关闭子视图裁剪：Android 上它会在程序化滚动 / 尺寸变化后
                // 把 cell 从原生视图树里摘掉，表现为「列表看得见但点不动，
                // 手指滑一下才恢复」。列表本身有虚拟化，不裁剪也不会多渲染。
                removeClippedSubviews={false}
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
                onScrollBeginDrag={handleScrollBegin}
                onScrollEndDrag={handleScrollEnd}
                onMomentumScrollEnd={handleScrollEnd}
                onScroll={e => {
                    scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
                }}
                scrollEventThrottle={32}
                renderItem={({ index, item: musicItem }) => {
                    return (
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
                            highlight={isSameMediaItem(musicItem, highlightMusicItem)}
                        />
                    );
                }}
                onEndReached={() => {
                    if (state === RequestStateCode.IDLE || state === RequestStateCode.PARTLY_DONE) {
                        onLoadMore?.();
                    }
                }}
                onEndReachedThreshold={0.1}
            />
            ) : null}
            {showBadge && (
                <View style={styles.badge} pointerEvents="box-none">
                    <Pressable
                        style={[styles.badgeButton, { backgroundColor: colors.notification }]}
                        onPress={scrollToHighlight}
                    >
                        <Icon
                            name="crosshair"
                            size={iconSizeConst.normal}
                            color={colors.text}
                        />
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
