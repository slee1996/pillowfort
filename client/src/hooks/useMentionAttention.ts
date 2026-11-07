import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { createMentionObserver } from "../services/mentionAttention";

export type MentionPermission = NotificationPermission | "unsupported";

function browserPermission(): MentionPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function useMentionAttention(focusedActivity: boolean, restoreConversation: () => void) {
  const roomId = useGameStore((state) => state.roomId);
  const name = useGameStore((state) => state.name);
  const [unreadMentions, setUnreadMentions] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<MentionPermission>(browserPermission);
  const [requesting, setRequesting] = useState(false);
  const activityRef = useRef(focusedActivity);
  const restoreRef = useRef(restoreConversation);
  const enabledRef = useRef(false);
  const requestingRef = useRef(false);
  const notificationRef = useRef<Notification | null>(null);
  const sessionRef = useRef<{ roomId: typeof roomId; name: string } | null>(null);
  const resetAttentionRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    activityRef.current = focusedActivity;
    restoreRef.current = restoreConversation;
    if (!focusedActivity && document.visibilityState === "visible" && document.hasFocus()) {
      resetAttentionRef.current?.();
    }
  }, [focusedActivity, restoreConversation]);

  useEffect(() => {
    const session = { roomId, name };
    sessionRef.current = session;
    enabledRef.current = false;
    requestingRef.current = false;
    setEnabled(false);
    setRequesting(false);
    setUnreadMentions(0);
    setPermission(browserPermission());
    const originalTitle = document.title;
    const observe = createMentionObserver(useGameStore.getState());
    let count = 0;
    const isActive = () => document.visibilityState === "visible" && document.hasFocus() && !activityRef.current;
    const syncAttention = () => {
      const currentPermission = browserPermission();
      setPermission(currentPermission);
      if (currentPermission !== "granted" && enabledRef.current) {
        enabledRef.current = false;
        setEnabled(false);
        notificationRef.current?.close();
        notificationRef.current = null;
      }
      if (isActive()) {
        count = 0;
        document.title = originalTitle;
        setUnreadMentions(0);
        notificationRef.current?.close();
        notificationRef.current = null;
      }
    };
    resetAttentionRef.current = syncAttention;
    document.addEventListener("visibilitychange", syncAttention);
    window.addEventListener("focus", syncAttention);
    const unsubscribe = useGameStore.subscribe((state) => {
      if (state.roomId !== roomId || state.name !== name) return;
      const mentions = observe(state);
      if (!mentions.length || isActive()) return;
      count += mentions.length;
      setUnreadMentions(count);
      document.title = `(${count} ${count === 1 ? "mention" : "mentions"}) ${originalTitle}`;
      if (!enabledRef.current || browserPermission() !== "granted") return;
      try {
        notificationRef.current?.close();
        const notification = new Notification("Pillowfort mention", {
          body: "Someone mentioned you in your fort. Open Pillowfort to read it.",
          tag: "pillowfort-mention",
        });
        notificationRef.current = notification;
        notification.onclick = () => {
          const state = useGameStore.getState();
          if (sessionRef.current !== session || state.roomId !== roomId || state.name !== name) return;
          window.focus();
          restoreRef.current();
          syncAttention();
          notification.close();
        };
      } catch {
        // Some browsers grant permission but do not support desktop Notification construction.
        // In-app attention remains available without a service worker or persisted subscription.
      }
    });
    return () => {
      sessionRef.current = null;
      resetAttentionRef.current = null;
      enabledRef.current = false;
      requestingRef.current = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", syncAttention);
      window.removeEventListener("focus", syncAttention);
      if (notificationRef.current) {
        notificationRef.current.onclick = null;
        notificationRef.current.close();
        notificationRef.current = null;
      }
      document.title = originalTitle;
    };
  }, [roomId, name]);

  const toggleNotifications = useCallback(async () => {
    if (enabledRef.current) {
      enabledRef.current = false;
      setEnabled(false);
      notificationRef.current?.close();
      notificationRef.current = null;
      return;
    }
    if (requestingRef.current) return;
    const current = browserPermission();
    setPermission(current);
    if (current === "unsupported" || current === "denied") return;
    const session = sessionRef.current;
    if (!session) return;
    requestingRef.current = true;
    setRequesting(true);
    try {
      // Only this explicit Room-menu click may request browser permission.
      const result = current === "granted" ? current : await Notification.requestPermission();
      const state = useGameStore.getState();
      if (sessionRef.current !== session || state.roomId !== session.roomId || state.name !== session.name) return;
      setPermission(result);
      enabledRef.current = result === "granted";
      setEnabled(result === "granted");
    } catch {
      if (sessionRef.current === session) setPermission(browserPermission());
    } finally {
      if (sessionRef.current === session) {
        requestingRef.current = false;
        setRequesting(false);
      }
    }
  }, []);

  return { unreadMentions, enabled, permission, requesting, toggleNotifications };
}
