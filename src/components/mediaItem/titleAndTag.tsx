import React from "react";
import { StyleSheet, View } from "react-native";
import rpx from "@/utils/rpx";
import ThemeText from "../base/themeText";
import Tag from "../base/tag";
import { CustomizedColors } from "@/hooks/useColors";

interface ITitleAndTagProps {
    title: string;
    titleFontColor?: keyof CustomizedColors;
    tag?: string;
    /** 源标签前的插槽（如下载文件数量角标），显示在标题右侧、源标签左侧 */
    tagLeading?: React.ReactNode;
    /** 点击源标签（例如打开换源面板） */
    onTagPress?: () => void;
}

export default function TitleAndTag(props: ITitleAndTagProps) {
    const { title, tag, titleFontColor, tagLeading, onTagPress } = props;
    return (
        <View style={styles.container}>
            <ThemeText fontColor={titleFontColor} numberOfLines={1} style={styles.title}>
                {title}
            </ThemeText>
            {tagLeading ?? null}
            {tag ? (
                onTagPress ? (
                    // 点源标签 → 换源。
                    // 这里不能用 TouchableOpacity/Pressable：外层 ListItem 是
                    // TouchableHighlight，内层 Touchable 的 onPress 常抢不到 responder，
                    // 会穿透成「播放整行」（实测只有个别行能点）。
                    // 用最底层的 responder 接管（onStartShouldSetResponder）才能可靠命中。
                    <View
                        style={styles.tagPressable}
                        hitSlop={{
                            top: rpx(14),
                            bottom: rpx(14),
                            left: rpx(12),
                            right: rpx(12),
                        }}
                        onStartShouldSetResponder={() => true}
                        onResponderRelease={onTagPress}>
                        <Tag tagName={tag} />
                    </View>
                ) : (
                    <Tag tagName={tag} />
                )
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: "row",
        alignItems: "center",
        // 源标签固定贴右端：flex-start 会让标签位置随标题长度漂移，
        // 表现为「某些行点得到、某些行点不到」。
        justifyContent: "space-between",
    },
    title: {
        flex: 1,
    },
    /** 源标签的点击热区（高度交给 hitSlop，父容器高度是自适应的） */
    tagPressable: {
        justifyContent: "center",
        flexShrink: 0,
    },
});
