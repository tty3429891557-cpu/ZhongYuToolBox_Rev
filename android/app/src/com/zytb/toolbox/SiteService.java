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

    /** 首选端口 8322（只监听 127.0.0.1，不对外网开放）；被占用时向后顺延 */
    public static final int PORT = 8322;

    private static volatile LocalWebServer server;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundInternal();
        if (server == null) {
            LocalWebServer s = new LocalWebServer(this, PORT);
            // 修复：原实现忽略 start() 结果，端口被占用时站点起不来却毫无提示
            if (!s.start()) {
                android.util.Log.e("ZytbSite", "本地站点启动失败：8322~" + (PORT + LocalWebServer.PORT_RANGE - 1) + " 均被占用");
                return START_STICKY;
            }
            server = s;
            android.util.Log.i("ZytbSite", "本地站点已启动：" + localUrl());
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (server != null) { server.stop(); server = null; }
        super.onDestroy();
    }

    /** 实际生效的地址（端口可能与首选不同） */
    public static String localUrl() {
        LocalWebServer s = server;
        int p = s != null ? s.getBoundPort() : 0;
        return "http://127.0.0.1:" + (p > 0 ? p : PORT) + "/";
    }

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
