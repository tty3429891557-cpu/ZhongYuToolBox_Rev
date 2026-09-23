package com.zytb.toolbox;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 主界面：打开即自动建站（启动前台服务 + 本地 HTTP 服务器），
 * 然后转到浏览器使用。设置里可开启保活（忽略电池优化）。
 */
public class MainActivity extends Activity {

    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        startSite();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(24), dp(20), dp(24));
        scroll.addView(box);
        setContentView(scroll);

        TextView title = new TextView(this);
        title.setText("中育ToolBox · 手机版");
        title.setTextSize(22);
        title.setPadding(0, 0, 0, dp(12));
        box.addView(title);

        status = new TextView(this);
        status.setTextSize(15);
        status.setPadding(0, 0, 0, dp(16));
        box.addView(status);

        addButton(box, "在浏览器中打开", new View.OnClickListener() {
            @Override public void onClick(View v) { openBrowser(); }
        });
        addButton(box, "忽略电池优化（保活）", new View.OnClickListener() {
            @Override public void onClick(View v) { requestIgnoreBattery(); }
        });
        addButton(box, "打开系统设置（应用详情）", new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null)));
            }
        });

        TextView tips = new TextView(this);
        tips.setText("使用说明：\n" +
                "1. 打开本程序会自动启动本地站点（保活服务）。\n" +
                "2. 点「在浏览器中打开」即可正常使用全部功能。\n" +
                "3. 若被系统清理，请点「忽略电池优化」并锁定后台。\n" +
                "4. 站点只监听 127.0.0.1，不对外网开放。");
        tips.setTextSize(13);
        tips.setPadding(0, dp(16), 0, 0);
        box.addView(tips);
    }

    private void addButton(LinearLayout box, String text, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(text);
        b.setOnClickListener(onClick);
        box.addView(b);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void startSite() {
        SiteService.start(this);
        String url = "http://127.0.0.1:" + SiteService.PORT + "/";
        status.setText("本地站点已启动（保活中）\n" + url + "\n\n点下方按钮在浏览器中打开。");
    }

    private void openBrowser() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(SiteService.localUrl())));
        } catch (Exception e) {
            android.widget.Toast.makeText(this, "未找到浏览器：" + e.getMessage(), android.widget.Toast.LENGTH_LONG).show();
        }
    }

    private void requestIgnoreBattery() {
        try {
            String pkg = getPackageName();
            if (Settings.Global.getInt(getContentResolver(), "ignore_battery_optimizations", 0) == 1
                    && !Settings.Global.getString(getContentResolver(), "ignore_battery_optimizations").contains(pkg)) {
                // 全局开关已开则无需再请求
            }
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + pkg)));
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception e2) {
                android.widget.Toast.makeText(this, "无法打开设置：" + e2.getMessage(), android.widget.Toast.LENGTH_LONG).show();
            }
        }
    }
}
