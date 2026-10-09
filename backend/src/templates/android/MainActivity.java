package com.askvi.gamewrapper;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;

// The whole Android app: one full-screen WebView playing the game bundled in
// assets/game/. Files are served from a fake https origin (not file://), so
// the game's ES modules and localStorage work exactly as in the browser.
// Shared by every exported game -- only the manifest, icon and assets change.
public class MainActivity extends Activity {
  private static final String HOST = "appassets.androidplatform.net";
  private WebView web;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    web = new WebView(this);
    web.setBackgroundColor(0xff000000);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        Uri url = req.getUrl();
        if (!HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        try {
          InputStream in = getAssets().open("game" + path);
          return new WebResourceResponse(mime(path), "utf-8", in);
        } catch (Exception e) {
          return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
              new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
      }

      // The game never leaves the app: links to other sites are ignored.
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        return !HOST.equals(req.getUrl().getHost());
      }
    });
    setContentView(web);
    hideSystemBars();
    web.loadUrl("https://" + HOST + "/index.html");
  }

  private static String mime(String path) {
    String p = path.toLowerCase();
    if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
    if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
    if (p.endsWith(".css")) return "text/css";
    if (p.endsWith(".json")) return "application/json";
    if (p.endsWith(".svg")) return "image/svg+xml";
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
    if (p.endsWith(".gif")) return "image/gif";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".wav")) return "audio/wav";
    if (p.endsWith(".mp3")) return "audio/mpeg";
    if (p.endsWith(".ogg")) return "audio/ogg";
    if (p.endsWith(".woff2")) return "font/woff2";
    if (p.endsWith(".woff")) return "font/woff";
    if (p.endsWith(".ttf")) return "font/ttf";
    if (p.endsWith(".txt") || p.endsWith(".md")) return "text/plain";
    return "application/octet-stream";
  }

  @SuppressWarnings("deprecation")
  private void hideSystemBars() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemBars();
  }

  @Override
  protected void onPause() {
    web.onPause();
    super.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    web.onResume();
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }
}
