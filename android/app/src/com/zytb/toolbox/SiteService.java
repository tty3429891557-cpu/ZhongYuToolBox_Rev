package com.zytb.toolbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：承载本地 HTTP 服务器（站点 + 内置代理）。
 * 前台服务是安卓保活的标准方式；配合「忽略电池优化」可大幅降低被系统清理的概率。
 */
public class SiteService extends Service {

    /** 端口固定为 8322（只监听 127.0.0.1，不对外网开放） */
    public static final int PORT = 8322;

    private static LocalWebServer server;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundInternal();
        if (server == null) {
            server = new LocalWebServer(this, PORT);
            server.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (server != null) { server.stop(); server = null; }
        super.onDestroy();
    }

    public static String localUrl() { return "http://127.0.0.1:" + PORT + "/"; }

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, SiteService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    private void startForegroundInternal() {
        String id = "zytb_site";
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(id, "本地站点", NotificationManager.IMPORTANCE_MIN);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, id)
                : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_menu_manage)
         .setContentTitle("中育ToolBox 站点运行中")
         .setContentText("本地站点与代理已启动，可在浏览器中使用");
        startForeground(20260923, b.build());
    }
}
