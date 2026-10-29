import { CustomizedColors } from "@/hooks/useColors";
import rpx from "@/utils/rpx";

const fontSizeConst = {
    /** 标签 */
    tag: rpx(20),
    /** 描述文本等字体 */
    description: rpx(22),
    /** 副标题 */
    subTitle: rpx(26),
    /** 正文字体 */
    content: rpx(28),
    /** 标题字体 */
    title: rpx(32),
    /** appbar的字体 */
    appbar: rpx(36),
};

const fontWeightConst = {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    bolder: "800",
} as const;

const iconSizeConst = {
    small: rpx(30),
    light: rpx(36),
    normal: rpx(42),
    big: rpx(60),
    large: rpx(72),
};

/**
 * 歌曲列表单行高度。
 * 必须与 mediaItem/musicItem 的 compactRow 高度严格一致：
 * 列表定位（scrollToOffset）是按时高 × 索引算偏移的，
 * 一旦行高和这里不一样，索引越大偏差越大 ——
 * 表现为「点某首歌列表自己乱跳」「定位到正在播放跑偏」。
 */
const musicListItemHeight = rpx(104);

type ColorKey = "normal" | "secondary" | "highlight" | "primary";
const colorMap: Record<ColorKey, keyof CustomizedColors> = {
    normal: "text",
    secondary: "textSecondary",
    highlight: "textHighlight",
    primary: "primary",
} as const;

export {
    fontSizeConst,
    fontWeightConst,
    iconSizeConst,
    colorMap,
    musicListItemHeight,
};
export type { ColorKey };
