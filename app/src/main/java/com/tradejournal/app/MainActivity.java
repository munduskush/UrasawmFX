package com.tradejournal.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Hosts the offline web app from /assets. Handles file picking (import, screenshots) and saving files (backup, CSV). */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_PICK = 1;
    private static final int REQ_SAVE = 2;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private String pendingText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0F1115);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!HOST.equals(request.getUrl().getHost())) {
                    // Block every request that is not our own bundled files.
                    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                }
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                String type = (types != null && types.length > 0 && types[0] != null && !types[0].isEmpty()) ? types[0] : "*/*";
                i.setType(type);
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (Exception e) {
                    pickCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl("https://" + HOST + "/assets/index.html");
    }

    /** Called from JavaScript: AndroidBridge.saveFile(name, mime, text). Opens the system "save as" screen. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pendingText = text;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mime);
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(i, REQ_SAVE);
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "No file saver available", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK) {
            if (pickCallback != null) {
                pickCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pickCallback = null;
            }
        } else if (requestCode == REQ_SAVE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingText != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    out.write(pendingText.getBytes(StandardCharsets.UTF_8));
                    Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
                } catch (IOException | RuntimeException e) {
                    Toast.makeText(this, "Could not save the file", Toast.LENGTH_LONG).show();
                }
            }
            pendingText = null;
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.handleBack && window.handleBack()) || false", value -> {
            if (!"true".equals(value)) finish();
        });
    }
}
