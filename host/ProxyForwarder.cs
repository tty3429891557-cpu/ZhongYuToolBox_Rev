using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Http;

namespace ZytbSiteHost;

/// <summary>
/// 内置本地代理：随站点程序启动/停止。
///   GET/POST /proxy/&lt;目标URL&gt;   转发（领创 JSON-RPC、图片/资源加速）
///   GET/POST /proxy?u=&lt;目标URL&gt;  同上（URL 编码形式，避免路径里的 // 被改写）
///   GET      /proxy/ping          健康检查
/// 所有响应都带 CORS 头（Access-Control-Allow-Origin: *），
/// 用于解决领创云接口不返回 CORS 头导致的浏览器直连失败。
/// 只做转发，不保存任何数据。
/// </summary>
internal static class ProxyForwarder
{
	private static readonly HttpClient Client = new(new SocketsHttpHandler
	{
		AllowAutoRedirect = true,
		UseCookies = false,
		AutomaticDecompression = DecompressionMethods.None
	})
	{
		Timeout = TimeSpan.FromSeconds(60)
	};

	public static async Task ProxyAsync(HttpContext ctx, string? target)
	{
		var resp = ctx.Response;
		resp.Headers["Access-Control-Allow-Origin"] = "*";
		resp.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
		resp.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Range";
		resp.Headers["Access-Control-Max-Age"] = "86400";

		if (HttpMethods.IsOptions(ctx.Request.Method))
		{
			resp.StatusCode = 200;
			return;
		}

		// 健康检查（/proxy/ping）
		if (string.Equals(target, "ping", StringComparison.OrdinalIgnoreCase))
		{
			resp.StatusCode = 200;
			resp.ContentType = "text/plain; charset=utf-8";
			await resp.WriteAsync("pong");
			return;
		}

		if (string.IsNullOrWhiteSpace(target))
		{
			resp.StatusCode = 400;
			resp.ContentType = "text/plain; charset=utf-8";
			await resp.WriteAsync("用法: /proxy/<目标URL> 或 /proxy?u=<URL编码后的目标>");
			return;
		}

		var lower = target.ToLowerInvariant();
		if (!lower.StartsWith("http://") && !lower.StartsWith("https://"))
		{
			target = "http://" + target;
		}

		// 整体超时：防止上游停滞导致请求悬挂（同时跟随客户端断开）
		using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
		timeoutCts.CancelAfter(TimeSpan.FromSeconds(300));
		try
		{
			using var msg = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), target);
			msg.Headers.UserAgent.ParseAdd("ZhongYuToolBox-LocalProxy/1.0");

			var range = ctx.Request.Headers["Range"].ToString();
			if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes="))
			{
				var first = range.Substring(6).Split('-')[0];
				if (long.TryParse(first, out var start))
				{
					msg.Headers.Range = new RangeHeaderValue(start, null);
				}
			}

			if (HttpMethods.IsPost(ctx.Request.Method))
			{
				using var ms = new MemoryStream();
				await ctx.Request.Body.CopyToAsync(ms);
				var data = ms.ToArray();
				var ct = ctx.Request.ContentType ?? "application/json";
				msg.Content = new ByteArrayContent(data);
				msg.Content.Headers.TryAddWithoutValidation("Content-Type", ct);
			}

			using var upstream = await Client.SendAsync(msg, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
			resp.StatusCode = (int)upstream.StatusCode;
			if (upstream.Content.Headers.ContentType != null)
			{
				resp.ContentType = upstream.Content.Headers.ContentType.ToString();
			}
			var contentRange = upstream.Content.Headers.ContentRange?.ToString();
			if (!string.IsNullOrEmpty(contentRange))
			{
				resp.Headers["Content-Range"] = contentRange;
			}
			resp.Headers["Accept-Ranges"] = "bytes";
			await upstream.Content.CopyToAsync(resp.Body, timeoutCts.Token);
		}
		catch (Exception ex)
		{
			resp.StatusCode = 502;
			resp.ContentType = "text/plain; charset=utf-8";
			await resp.WriteAsync("转发失败: " + ex.Message);
		}
	}
}
