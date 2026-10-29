import { State } from "react-native-track-player";

/**
 * 音乐是否处于停止状态
 * @param state
 * @returns
 */
export const musicIsPaused = (state: State | undefined) =>
    state !== State.Playing;

/**
 * 音乐是否处于缓冲中状态（真正在播、卡网络）
 *
 * 只认 Buffering，**不包括 Loading**：
 * Loading 是「播放器在准备音源、但 playWhenReady=false」的状态。
 * 启动恢复上次播放的歌时，音源会被塞进队列且不自动播放，此时就是 Loading；
 * 一旦那条链接准备不出来（元力链接过期、插件没返回新地址），
 * 播放器会永远停在 Loading —— 如果把它当成缓冲中，
 * 播放栏就会显示一个点不动的加载圈（既没声音也按不了播放）。
 *
 * @param state
 * @returns
 */
export const musicIsBuffering = (state: State | undefined) =>
    state === State.Buffering;
