import { useGameStore } from "./stores/gameStore";
import { HomeScreen } from "./screens/HomeScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { JoinScreen } from "./screens/JoinScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { KnockedScreen } from "./screens/KnockedScreen";
import { Toast } from "./components/xp/Toast";
import { ErrorBanner } from "./components/xp/ErrorBanner";
import { ReconnectBanner } from "./components/xp/ReconnectBanner";

export function App() {
  const screen = useGameStore((s) => s.screen);

  return (
    <>
      <ErrorBanner />
      <ReconnectBanner />
      <Toast />
      {screen === "home" && <HomeScreen />}
      {screen === "setup" && <SetupScreen />}
      {screen === "join" && <JoinScreen />}
      {screen === "chat" && <ChatScreen />}
      {screen === "knocked" && <KnockedScreen />}
    </>
  );
}
