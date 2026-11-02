package com.aliahad.wovoice.bubble;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.text.Editable;
import android.text.Spanned;
import android.text.SpannableString;
import android.text.TextWatcher;
import android.text.style.StyleSpan;
import android.graphics.Typeface;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A standalone external editor in the test APK, never the distributed app.
 * Java keeps this fixture independent of libraries deduplicated into the target APK.
 */
public class BubbleEditorFixtureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(32, 100, 32, 32);
        String[] labels = {"First test text box", "Second test text box", "Password test text box", "Empty test text box", "Limited test text box"};
        for (int index = 0; index < labels.length; index++) {
            EditText field = new EditText(this);
            field.setContentDescription(labels[index]);
            field.setInputType(InputType.TYPE_CLASS_TEXT | (index == 2
                ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
            if (index == 4) field.setFilters(new InputFilter[] {new InputFilter.LengthFilter(10)});
            field.setText(index == 0 ? "Before after" : index == 3 ? "" : index == 4 ? "HelloWorld" : "Untouched");
            if (index == 3) field.setHint("This hint must not become dictated text");
            field.setMinHeight(160);
            body.addView(field, new LinearLayout.LayoutParams(-1, 180));
            if (index == 0) { field.requestFocus(); field.setSelection(6); }
        }
        EditText rich = new EditText(this);
        rich.setContentDescription("Rich test text box");
        SpannableString styled = new SpannableString("Bold tail");
        styled.setSpan(new StyleSpan(Typeface.BOLD), 0, 4, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        styled.setSpan(new StyleSpan(Typeface.ITALIC), 5, 9, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        rich.setText(styled);
        body.addView(rich, new LinearLayout.LayoutParams(-1, 180));
        TextView status = new TextView(this);
        status.setContentDescription("Rich formatting status");
        status.setText("Formatting preserved");
        body.addView(status, new LinearLayout.LayoutParams(-1, 100));
        rich.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) {}
            public void afterTextChanged(Editable text) {
                boolean bold = false, italic = false;
                for (StyleSpan span : text.getSpans(0, text.length(), StyleSpan.class)) {
                    String part = text.subSequence(text.getSpanStart(span), text.getSpanEnd(span)).toString();
                    if (span.getStyle() == Typeface.BOLD && part.equals("Bold")) bold = true;
                    if (span.getStyle() == Typeface.ITALIC && part.equals("tail")) italic = true;
                }
                status.setText(bold && italic ? "Formatting preserved" : "Formatting lost");
                // Some real rich editors restart their input session after accepting a change.
                getSystemService(android.view.inputmethod.InputMethodManager.class).restartInput(rich);
            }
        });
        setContentView(body);
    }
}
