package io.github.darazumovskiy.tanks;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

// Игра занимает весь экран: системные панели скрыты и возвращаются свайпом от края; экран не гаснет во время боя.
// Ссылка на бой, открывшая приложение, грузится в WebView вместо главной.
public class MainActivity extends BridgeActivity {
  private static final String WIFI_LOCK_TAG = "tanks:game";

  // Пока игра на экране, Wi-Fi не уходит в энергосбережение: иначе часть телефонов (Samsung с One UI 7+)
  // раз в пару секунд замирает на сотни миллисекунд, и бой дёргается.
  private WifiManager.WifiLock wifiLock;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
  }

  @Override
  public void onResume() {
    super.onResume();
    WifiManager.WifiLock lock = wifiLock();
    if (lock != null) {
      lock.acquire();
    }
  }

  @Override
  public void onPause() {
    super.onPause();
    if (wifiLock != null && wifiLock.isHeld()) {
      wifiLock.release();
    }
  }

  // Режим низкой задержки — с Android 10; раньше ближайший — высокая производительность.
  @SuppressWarnings("deprecation")
  private WifiManager.WifiLock wifiLock() {
    if (wifiLock != null) {
      return wifiLock;
    }
    WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    if (wifi == null) {
      return null;
    }
    boolean hasLowLatency = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
    int mode = hasLowLatency ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
    wifiLock = wifi.createWifiLock(mode, WIFI_LOCK_TAG);
    wifiLock.setReferenceCounted(false);
    return wifiLock;
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (!hasFocus) {
      return;
    }
    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.hide(WindowInsetsCompat.Type.systemBars());
    controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
  }

  // Capacitor вызывает этот метод и для intent запуска, и когда ссылка пришла в уже открытое приложение.
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
      return;
    }
    Uri link = intent.getData();
    if (link == null || !isGameServerLink(link)) {
      return;
    }
    getBridge().getWebView().loadUrl(link.toString());
  }

  // В WebView попадают только адреса сервера игры: в его страницы встроен мост к приложению.
  private boolean isGameServerLink(Uri link) {
    String serverUrl = getBridge().getServerUrl();
    if (serverUrl == null || link.getHost() == null) {
      return false;
    }
    return link.getHost().equalsIgnoreCase(Uri.parse(serverUrl).getHost());
  }
}
