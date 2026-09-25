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

    /** 尝试的端口上限（含）：8322 被占用时依次往后找，避免「静默启动失败」 */
    public static final int PORT_RANGE = 10;

    private final int port;
    private final File webRoot;
    private ServerSocket socket;
    private Thread acceptThread;

    /**
     * 请求处理线程池。
     * 修复：原实现是「一个连接 = 一条新线程」且无上限。浏览器加载一个页面会并发请求
     * 几十上百个资源（JS/CSS/图片/字体），瞬间创建上百条线程 → 低端机（MuMu/老手机）
     * 直接 OOM 或 ANR，表现为「打开就白屏/闪退」。改为固定上限线程池 + 有界队列。
     */
    private final java.util.concurrent.ExecutorService pool =
            new java.util.concurrent.ThreadPoolExecutor(
                    4, 16, 30L, java.util.concurrent.TimeUnit.SECONDS,
                    new java.util.concurrent.ArrayBlockingQueue<Runnable>(64),
                    new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());

    /** 实际监听到的端口（可能与传入的不同） */
    private volatile int boundPort = 0;

    public LocalWebServer(Context ctx, int port) {
        this.port = port;
        this.webRoot = extractSite(ctx);
    }

    /** 实际端口；未成功启动时返回 0 */
    public int getBoundPort() { return boundPort; }

    /** 把 assets 里的站点文件解压到 filesDir/wwwroot（保留子目录结构；按版本号判断是否需要更新） */
    private File extractSite(Context ctx) {
        File base = ctx.getFilesDir();
        File dir = new File(base, "wwwroot");
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
                copyAssets(ctx, "wwwroot", dir);    // outDir 即目标目录：文件写到 dir/<名>，子目录递归进入
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

    /**
     * 递归复制 assets 子树到 outDir，保持相对路径结构。
     * 先用 list() 区分文件与目录：文件直接写出；目录才建子文件夹并递归。
     * （此前两个版本分别把文件平铺到顶层、或把文件名先建成目录——都会导致白屏）
     */
    private static void copyAssets(Context ctx, String assetPath, File outDir) throws IOException {
        String[] list = ctx.getAssets().list(assetPath);
        if (list == null || list.length == 0) {
            // 文件
            File out = new File(outDir, new File(assetPath).getName());
            out.getParentFile().mkdirs();
            try (InputStream in = ctx.getAssets().open(assetPath); OutputStream o = new FileOutputStream(out)) {
                byte[] b = new byte[8192]; int n;
                while ((n = in.read(b)) > 0) o.write(b, 0, n);
            }
            return;
        }
        for (String child : list) {
            String childAsset = assetPath + "/" + child;
            String[] sub = ctx.getAssets().list(childAsset);
            if (sub == null || sub.length == 0) {
                File out = new File(outDir, child);
                out.getParentFile().mkdirs();
                try (InputStream in = ctx.getAssets().open(childAsset); OutputStream o = new FileOutputStream(out)) {
                    byte[] b = new byte[8192]; int n;
                    while ((n = in.read(b)) > 0) o.write(b, 0, n);
                }
            } else {
                File subDir = new File(outDir, child);
                subDir.mkdirs();
                copyAssets(ctx, childAsset, subDir);
            }
        }
    }

    private static void deleteRecursive(File f) {
        File[] list = f.listFiles();
        if (list != null) for (File c : list) { if (c.isDirectory()) deleteRecursive(c); else c.delete(); }
        f.delete();
    }

    /**
     * 启动监听。
     * 修复：原实现在端口被占用时 `catch (IOException) { return; }` 直接静默返回，
     * 调用方（SiteService）完全不知道没起来，界面依旧显示「站点已启动」，
     * 用户点「在浏览器中打开」只会看到无法连接。现改为端口递进重试 + 暴露实际端口，
     * 全部失败时返回 false 供上层提示。
     */
    public synchronized boolean start() {
        if (socket != null) return true;
        ServerSocket s = null;
        int used = 0;
        for (int i = 0; i < PORT_RANGE; i++) {
            int p = port + i;
            try {
                s = new ServerSocket(p, 64, InetAddress.getByName("127.0.0.1"));
                used = p;
                break;
            } catch (IOException ignored) { }
        }
        if (s == null) return false;
        socket = s;
        boundPort = used;
        final ServerSocket listening = s;
        acceptThread = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted() && !listening.isClosed()) {
                try {
                    Socket client = listening.accept();
                    final Socket c = client;
                    try {
                        pool.execute(() -> handle(c));
                    } catch (java.util.concurrent.RejectedExecutionException e) {
                        try { c.close(); } catch (IOException ignored) { }
                    }
                } catch (IOException e) { break; }
            }
        }, "zytb-site-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return true;
    }

    public synchronized void stop() {
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        socket = null;
        boundPort = 0;
        pool.shutdownNow();
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
                String allowOrigin = isSameSite(req, boundPort) ? req.header("Origin") : null;
                if ("OPTIONS".equalsIgnoreCase(req.method)) {
                    respondCors(client, 204, "text/plain; charset=utf-8", new byte[0], allowOrigin);
                    return;
                }
                String u = param(query, "u");
                if (u == null || u.isEmpty()) {
                    respond(client, 400, "text/plain; charset=utf-8", "用法: /proxy?u=<目标URL>".getBytes("UTF-8"));
                    return;
                }
                forward(client, u, req.method, req.body, req.header("Content-Type"), allowOrigin);
                return;
            }

            // 静态站点
            String rel = path.equals("/") ? "index.html" : path.substring(1);
            // 修复：原实现未做 URL 解码，路径里含中文/空格（%E4%B8%AD.../%20）的资源一律 404
            rel = decode(rel);
            rel = rel.replace('\\', '/');
            // 目录穿越防护必须在解码之后，否则 "%2e%2e%2f" 可以绕过
            if (rel.contains("..")) { respond(client, 400, "text/plain", "bad path".getBytes()); return; }
            File f = new File(webRoot, rel);
            if (f.isDirectory()) f = new File(f, "index.html");
            if (!f.isFile()) { respond(client, 404, "text/plain; charset=utf-8", "404 Not Found".getBytes()); return; }
            String mime = guessMime(f.getName());
            // Range 支持（206 Partial Content）：在线视频/音频拖动进度、大文件续传都依赖它。
            // 原实现一律返回整个文件且没有 Accept-Ranges，播放器无法 seek。
            long[] range = parseRange(req.header("Range"), f.length());
            if (range != null) {
                long start = range[0], end = range[1];
                byte[] part = readRange(f, start, end);
                respondRange(client, 206, mime, part, start, end, f.length(),
                        isSameSite(req, boundPort) ? req.header("Origin") : null);
                return;
            }
            byte[] data = readAll(f);
            respondAcceptRanges(client, 200, mime, data);
        } catch (Exception e) {
            try { respond(client, 500, "text/plain", ("server error: " + e).getBytes("UTF-8")); } catch (Exception ignored) { }
        } finally {
            try { client.close(); } catch (IOException ignored) { }
        }
    }

    /**
     * 代理放行的目标域名（后缀匹配，小写）。
     * 与 Windows 宿主 ProxyForwarder 的默认白名单保持一致。
     *
     * 安全说明：本代理监听 127.0.0.1，但**同一台手机上任意 App 都能访问到它**。
     * 原先无鉴权、无目标限制，等于给本机装了一个开放代理，
     * 其它 App 可借它探测内网 / 打云元数据接口。这里补上域名白名单与方法白名单。
     */
    private static final String[] ALLOW_HOSTS = {
            "cloud.linspirer.com",  // 领创云 JSON-RPC（本代理的主要用途）
            "linspirer.com",
            "zykj.org",             // 中育学校域名
            "zyai.cc",              // pdf2img 等自有服务
            "aliyuncs.com",         // 阿里云 OSS
            "aliyuncdn.com",
            "alicdn.com",
            "qbox.me",
            "qiniucdn.com"
    };

    private static boolean isAllowedTarget(String target) {
        if (target == null) return false;
        String t = target.toLowerCase();
        if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
        String host;
        try {
            host = new java.net.URL(target).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase();
        // 硬黑名单：回环 / 链路本地（含 169.254.169.254 云元数据）/ 私网
        if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1")
                || host.equals("[::1]") || host.equals("0.0.0.0")) return false;
        if (host.startsWith("127.") || host.startsWith("0.")
                || host.startsWith("169.254.") || host.startsWith("10.")
                || host.startsWith("192.168.")) return false;
        if (host.startsWith("172.")) {
            String[] p = host.split("\\.");
            if (p.length > 1) {
                try {
                    int n = Integer.parseInt(p[1]);
                    if (n >= 16 && n <= 31) return false;   // 172.16.0.0/12
                } catch (NumberFormatException ignored) { }
            }
        }
        for (String suffix : ALLOW_HOSTS) {
            if (host.equals(suffix) || host.endsWith("." + suffix)) return true;
        }
        return false;
    }

    /** 转发到目标地址（领创 JSON-RPC 需要 POST；资源加速需要 GET） */
    private void forward(Socket client, String target, String method, byte[] body, String contentType, String allowOrigin) {
        // 方法白名单
        if (!"GET".equals(method) && !"POST".equals(method) && !"HEAD".equals(method)) {
            try {
                respond(client, 405, "text/plain; charset=utf-8", "本代理只支持 GET / POST / HEAD".getBytes("UTF-8"));
            } catch (Exception ignored) { }
            return;
        }
        // 域名白名单 + 回环/私网/元数据黑名单
        if (!isAllowedTarget(target)) {
            try {
                respond(client, 403, "text/plain; charset=utf-8",
                        ("目标主机不在放行名单内：" + target).getBytes("UTF-8"));
            } catch (Exception ignored) { }
            return;
        }
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL u = new java.net.URL(target);
            conn = (java.net.HttpURLConnection) u.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            // 不自动跟随重定向：否则 30x 可以把请求带到白名单之外的主机，绕过域名校验
            conn.setInstanceFollowRedirects(false);
            if (body != null && body.length > 0) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", contentType == null ? "application/json" : contentType);
                try (OutputStream o = conn.getOutputStream()) { o.write(body); }
            }
            int code = conn.getResponseCode();
            String ctype = conn.getContentType();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] data = readAllStream(in);
            respondCors(client, code, ctype == null ? "application/octet-stream" : ctype, data, allowOrigin);
        } catch (Exception e) {
            // 不要把异常原文透出（可能含内网地址等），只给类别
            try {
                respond(client, 502, "text/plain; charset=utf-8",
                        ("转发失败: " + e.getClass().getSimpleName()).getBytes("UTF-8"));
            } catch (Exception ignored) { }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 解析 `Range: bytes=start-end`（end 可省略）；非法或越界返回 null */
    private static long[] parseRange(String header, long total) {
        if (header == null || !header.toLowerCase().startsWith("bytes=")) return null;
        String spec = header.substring(6).trim();
        if (spec.isEmpty()) return null;
        try {
            long start, end;
            int dash = spec.indexOf('-');
            if (dash < 0) return null;
            String s = spec.substring(0, dash).trim();
            String e = spec.substring(dash + 1).trim();
            if (s.isEmpty()) {
                // bytes=-N ：最后 N 字节
                long n = Long.parseLong(e);
                if (n <= 0) return null;
                start = Math.max(0, total - n);
                end = total - 1;
            } else {
                start = Long.parseLong(s);
                end = e.isEmpty() ? total - 1 : Long.parseLong(e);
            }
            if (start < 0 || start >= total || end < start) return null;
            if (end >= total) end = total - 1;
            return new long[]{ start, end };
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    /** 读取文件的 [start, end] 闭区间 */
    private static byte[] readRange(File f, long start, long end) throws IOException {
        int len = (int) (end - start + 1);
        byte[] buf = new byte[len];
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
            raf.seek(start);
            int off = 0, n;
            while (off < len && (n = raf.read(buf, off, len - off)) > 0) off += n;
        }
        return buf;
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

    /** 无 CORS 头的响应（静态文件用，同源无需 CORS） */
    private static void respond(Socket client, int status, String contentType, byte[] data) throws IOException {
        respondCors(client, status, contentType, data, null);
    }

    /**
     * 响应。
     * @param allowOrigin 为 null 时不输出任何 CORS 头。
     *   修复：原实现无条件输出 `Access-Control-Allow-Origin: *`，
     *   而站点本身就同源（127.0.0.1:8322），并不需要 CORS；
     *   `*` 反而让任意网页都能读取本代理的响应。现在只在 Origin 与 Host 同源时才回 Allow-Origin。
     */
    private static void respondCors(Socket client, int status, String contentType, byte[] data, String allowOrigin)
            throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(data.length).append("\r\n");
        if (allowOrigin != null && !allowOrigin.isEmpty()) {
            head.append("Access-Control-Allow-Origin: ").append(allowOrigin).append("\r\n");
            head.append("Vary: Origin\r\n");
            head.append("Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n");
            head.append("Access-Control-Allow-Headers: Content-Type, Authorization, Range\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        OutputStream o = client.getOutputStream();
        o.write(head.toString().getBytes("UTF-8"));
        o.write(data);
        o.flush();
    }

    /** 200 响应，附带 Accept-Ranges: bytes（告知客户端支持分段） */
    private static void respondAcceptRanges(Socket client, int status, String contentType, byte[] data)
            throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(data.length).append("\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Connection: close\r\n\r\n");
        OutputStream o = client.getOutputStream();
        o.write(head.toString().getBytes("UTF-8"));
        o.write(data);
        o.flush();
    }

    /** 206 Partial Content 响应 */
    private static void respondRange(Socket client, int status, String contentType, byte[] data,
                                     long start, long end, long total, String allowOrigin)
            throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(data.length).append("\r\n");
        head.append("Content-Range: bytes ").append(start).append('-').append(end)
                .append('/').append(total).append("\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        if (allowOrigin != null && !allowOrigin.isEmpty()) {
            head.append("Access-Control-Allow-Origin: ").append(allowOrigin).append("\r\n");
            head.append("Vary: Origin\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        OutputStream o = client.getOutputStream();
        o.write(head.toString().getBytes("UTF-8"));
        o.write(data);
        o.flush();
    }

    private static String statusText(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            default: return "Status";
        }
    }

    /** Origin 是否与本站同源（Host 即 127.0.0.1:<port>） */
    private static boolean isSameSite(Request req, int port) {
        String origin = req.header("Origin");
        if (origin == null || origin.isEmpty()) return false;
        String[] expected = { "http://127.0.0.1:" + port, "http://localhost:" + port };
        for (String e : expected) {
            if (origin.equalsIgnoreCase(e)) return true;
        }
        return false;
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
        // 修复：缺 webp（图库/云笔记缩略图大量使用）时会被当成 octet-stream，
        // 浏览器不会渲染，表现为「图片全是空白/下载框」。同时补齐 mjs/map/apk/webm/mp4。
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".bmp")) return "image/bmp";
        if (name.endsWith(".mjs")) return "application/javascript";
        if (name.endsWith(".map")) return "application/json";
        if (name.endsWith(".apk")) return "application/vnd.android.package-archive";
        if (name.endsWith(".webm")) return "video/webm";
        if (name.endsWith(".mp4")) return "video/mp4";
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
