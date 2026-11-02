package com.aliahad.wovoice.bubble;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Offline HTML fixture for the real bubble; this activity is only in the test APK. */
public class BubbleWebEditorFixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (getIntent().getBooleanExtra("autofocus", false)) {
                    view.requestFocus();
                    view.evaluateJavascript("(()=>{const e=document.getElementById('rich');e.focus();"
                        + "const r=document.createRange();r.selectNodeContents(e);r.collapse(false);"
                        + "const s=getSelection();s.removeAllRanges();s.addRange(r);})()", null);
                }
            }
        });
        web.loadDataWithBaseURL("https://wovoice.test/", "<!doctype html><html><head>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{font:22px sans-serif;padding:24px;background:#fff;color:#111}"
            + "[contenteditable],textarea,input{display:block;border:1px solid #666;padding:12px;"
            + "margin:12px 0 24px;min-height:64px;width:90%;font:22px sans-serif}</style></head><body>"
            + "<label>Rich HTML editor<div id='rich' role='textbox' aria-label='Rich web test text box' "
            + "contenteditable='true' spellcheck='false'><b>Bold</b> <i>tail</i> <a href='#'>link</a></div></label>"
            + "<div id='status' role='status' aria-live='polite'>Formatting preserved</div>"
            + "<label>Multiline<textarea aria-label='Multiline web test text box'></textarea></label>"
            + "<label>Plain<input aria-label='Plain web test text box'></label>"
            + "<label>Password<input type='password' aria-label='Password web test text box'></label>"
            + "<script>const richEditor=document.getElementById('rich'),report=document.getElementById('status');"
            + "richEditor.addEventListener('input',()=>{report.textContent="
            + "richEditor.querySelector('b')?.textContent.includes('Bold')&&richEditor.querySelector('i')?.textContent.includes('tail')"
            + "&&richEditor.querySelector('a')?.getAttribute('href')==='#'?'Formatting preserved':'Formatting lost';});"
            + "</script></body></html>", "text/html", "UTF-8", null);
        setContentView(web);
    }
}
