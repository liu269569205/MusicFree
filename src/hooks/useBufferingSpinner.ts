import { useEffect, useState } from "react";

/**
 * 缓冲态的「有限转圈」。
 *
 * 播放器卡在缓冲中（音源失效、网络断了）时，UI 不该无限转圈 ——
 * 转圈控件通常不可点，用户既听不到歌，也没法按播放重试。
 * 超过 timeout 就当作普通暂停处理，把播放键还回去：
 * 用户再按一次会走「重新取源」的流程。
 */
export default function useBufferingSpinner(
    isBuffering: boolean,
    timeout = 8000,
) {
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        if (!isBuffering) {
            setTimedOut(false);
            return;
        }
        const timer = setTimeout(() => setTimedOut(true), timeout);
        return () => {
            clearTimeout(timer);
        };
    }, [isBuffering, timeout]);

    return isBuffering && !timedOut;
}
