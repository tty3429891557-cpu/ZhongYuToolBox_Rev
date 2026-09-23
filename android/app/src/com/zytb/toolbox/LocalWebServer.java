package com.zytb.toolbox;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/**
 * 极简本地 HTTP 服务器（零依赖）：
 *   1. 静态站点：服务 filesDir/wwwroot（首次启动从 APK assets 解压）
 *   2. 内置代理：GET/POST /proxy?u=<URL编码目标> → 转发（领创接口/资源加速）
 * 只监听 127.0.0.1，不对外网开放。
 */
public class LocalWebServer {

    private final int port;
    private final File webRoot;
    private ServerSocket socket;
    private Thread acceptThread;

    public LocalWebServer(Context ctx, int port) {
        this.port = port;
        this.webRoot = extractSite(ctx);
    }

    /** 把 assets 里的站点文件解压到 filesDir/wwwroot（覆盖更新：按 assets 版本号判断） */
    private File extractSite(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "wwwroot");
        File mark = new File(ctx.getFilesDir(), "site_version.txt");
        String ver;
        try {
            java.util.Properties p = new java.util.Properties();
            p.load(ctx.getAssets().open("site_version.txt"));
            ver = p.getProperty("version", "");
        } catch (Exception e) { ver = ""; }
        boolean need = !dir.isDirectory() || !mark.exists() || !ver.equals(readFile(mark));
        if (need) {
            try {
                if (dir.exists()) deleteRecursive(dir);
                copyAssets(ctx, "wwwroot", dir);
                writeFile(mark, ver);
            } catch (Exception ignored) { }
        }
        return dir;
    }

    private static String readFile(File f) {
        try { return new String(java.nio.file.Files.readAllBytes(f.toPath())); }
        catch (Throwable t) {
            // API < 26 无 java.nio.Files，退回普通流
            try (InputStream in = new FileInputStream(f); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
                byte[] b = new byte[4096]; int n;
                while ((n = in.read(b)) > 0) bo.write(b, 0, n);
                return bo.toString("UTF-8");
            } catch (Exception e) { return ""; }
        }
    }

    private static void writeFile(File f, String s) {
        try (OutputStream o = new FileOutputStream(f)) { o.write(s.getBytes("UTF-8")); } catch (Exception ignored) { }
    }

    private static void copyAssets(Context ctx, String path, File outDir) throws IOException {
        String[] list = ctx.getAssets().list(path);
        outDir.mkdirs();
        if (list == null || list.length == 0) {
            // 文件
            File out = new File(outDir, new File(path).getName());
            try (InputStream in = ctx.getAssets().open(path); OutputStream o = new FileOutputStream(out)) {
                byte[] b = new byte[8192]; int n;
                while ((n = in.read(b)) > 0) o.write(b, 0, n);
            }
            return;
        }
        for (String child : list) copyAssets(ctx, path + "/" + child, outDir);
    }

    private static void deleteRecursive(File f) {
        File[] list = f.listFiles();
        if (list != null) for (File c : list) { if (c.isDirectory()) deleteRecursive(c); else c.delete(); }
        f.delete();
    }

    public synchronized void start() {
        if (socket != null) return;
        try {
            socket = new ServerSocket(port, 64, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) { return; }
        acceptThread = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted() && socket != null && !socket.isClosed()) {
                try {
                    Socket client = socket.accept();
                    new Thread(() -> handle(client)).start();
                } catch (IOException e) { break; }
            }
        }, "zytb-site-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public synchronized void stop() {
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        socket = null;
    }

    private void handle(Socket client) {
        try {
            client.setSoTimeout(60000);
            Request req = Request.read(client.getInputStream());
            if (req == null) { client.close(); return; }

            String path = req.path;
            String query = req.query;

            if (path.startsWith("/proxy")) {
                // 内置代理：/proxy?u=<URL编码目标>，GET/POST 均可
                String u = param(query, "u");
                if (u == null || u.isEmpty()) { respond(client, 400, "text/plain; charset=utf-8", "用法: /proxy?u=<目标URL>".getBytes("UTF-8")); return; }
                byte[] body = req.body;
                forward(client, u, req.method, body, req.header("Content-Type"));
                return;
            }

            // 静态站点
            String rel = path.equals("/") ? "index.html" : path.substring(1);
            rel = rel.replace('\\', '/');
            if (rel.contains("..")) { respond(client, 400, "text/plain", "bad path".getBytes()); return; }
            File f = new File(webRoot, rel);
            if (f.isDirectory()) f = new File(f, "index.html");
            if (!f.isFile()) { respond(client, 404, "text/plain; charset=utf-8", "404 Not Found".getBytes()); return; }
            byte[] data = readAll(f);
            String mime = guessMime(f.getName());
            respond(client, 200, mime, data);
        } catch (Exception e) {
            try { respond(client, 500, "text/plain", ("server error: " + e).getBytes("UTF-8")); } catch (Exception ignored) { }
        } finally {
            try { client.close(); } catch (IOException ignored) { }
        }
    }

    /** 转发到目标地址（领创 JSON-RPC 需要 POST；资源加速需要 GET） */
    private void forward(Socket client, String target, String method, byte[] body, String contentType) {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL u = new java.net.URL(target);
            conn = (java.net.HttpURLConnection) u.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            if (body != null && body.length > 0) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", contentType == null ? "application/json" : contentType);
                try (OutputStream o = conn.getOutputStream()) { o.write(body); }
            }
            int code = conn.getResponseCode();
            String ctype = conn.getContentType();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] data = readAllStream(in);
            respond(client, code, ctype == null ? "application/octet-stream" : ctype, data);
        } catch (Exception e) {
            try { respond(client, 502, "text/plain; charset=utf-8", ("转发失败: " + e).getBytes("UTF-8")); } catch (Exception ignored) { }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f); ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192]; int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return bo.toByteArray();
        }
    }

    private static byte[] readAllStream(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        try (ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192]; int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return bo.toByteArray();
        }
    }

    private static void respond(Socket client, int status, String contentType, byte[] data) throws IOException {
        String head = "HTTP/1.1 " + status + " OK\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + data.length + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Authorization, Range\r\n" +
                "Connection: close\r\n\r\n";
        OutputStream o = client.getOutputStream();
        o.write(head.getBytes("UTF-8"));
        o.write(data);
        o.flush();
    }

    private static String guessMime(String name) {
        name = name.toLowerCase();
        if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html; charset=utf-8";
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".ico")) return "image/x-icon";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".zip")) return "application/zip";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".woff")) return "font/woff";
        if (name.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    private static String param(String query, String key) {
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int i = pair.indexOf('=');
            String k = i < 0 ? pair : pair.substring(0, i);
            if (k.equals(key)) return decode(i < 0 ? "" : pair.substring(i + 1));
        }
        return null;
    }

    private static String decode(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    /** 简易 HTTP 请求解析 */
    private static class Request {
        String method;
        String path;
        String query;
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        String header(String name) {
            for (Map.Entry<String, String> e : headers.entrySet())
                if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
            return null;
        }

        static Request read(InputStream in) throws IOException {
            StringBuilder head = new StringBuilder();
            int prev = -1, c;
            while ((c = in.read()) != -1) {
                head.append((char) c);
                if (prev == '\r' && c == '\n' && head.length() >= 4
                        && head.substring(head.length() - 4).equals("\r\n\r\n")) break;
                prev = c;
                if (head.length() > 64 * 1024) break;
            }
            String headStr = head.toString();
            int lineEnd = headStr.indexOf("\r\n");
            if (lineEnd < 0) return null;
            String[] parts = headStr.substring(0, lineEnd).split(" ");
            if (parts.length < 2) return null;
            Request r = new Request();
            r.method = parts[0];
            String target = parts[1];
            int q = target.indexOf('?');
            r.path = q < 0 ? target : target.substring(0, q);
            r.query = q < 0 ? null : target.substring(q + 1);
            for (String line : headStr.substring(lineEnd + 2).split("\r\n")) {
                int i = line.indexOf(':');
                if (i > 0) r.headers.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
            }
            // 读取请求体（Content-Length）
            int len = 0;
            String cl = r.header("Content-Length");
            if (cl != null) { try { len = Integer.parseInt(cl.trim()); } catch (Exception ignored) { } }
            if (len > 0) {
                r.body = new byte[len];
                int off = 0, n;
                while (off < len && (n = in.read(r.body, off, len - off)) > 0) off += n;
            }
            return r;
        }
    }
}
