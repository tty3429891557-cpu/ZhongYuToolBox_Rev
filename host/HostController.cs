using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using System.Net.NetworkInformation;
using Microsoft.Extensions.Logging;

namespace ZytbSiteHost;

/// <summary>
/// 站点与内置代理的宿主控制器：负责配置、启动、停止与应用新配置。
/// 端口策略：首次启动随机选取并持久化到 config.json，之后一直使用该端口；
/// 可通过设置界面、直接编辑 config.json 或命令行 --port 更改。
/// </summary>
internal sealed class HostController
{
	private static string DataDirectory => Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZytbSiteHost");

	public AppConfig Config { get; private set; } = new();

	public WebApplication? App { get; private set; }

	/** 本机访问地址（浏览器用） */
	public string LocalUrl => $"http://127.0.0.1:{Config.port}/";

	/** 全部监听前缀（Kestrel 格式） */
	public string[] Urls { get; private set; } = Array.Empty<string>();

	/** 读取配置；不存在则创建（端口随机并持久化）。命令行参数可覆盖并持久化。 */
	public void LoadOrCreate(string[] args)
	{
		var cfg = AppConfig.Load() ?? new AppConfig
		{
			port = ReserveFreePort(),
			listen = "127.0.0.1",
			openBrowser = true
		};
		Config = cfg;
		ApplyArgs(args);
		Config.Save();
	}

	/** 命令行覆盖：--port=NNN / --port NNN / --listen=xxx（持久化）；--no-browser 仅本次生效 */
	public void ApplyArgs(string[] args)
	{
		var text = args.FirstOrDefault((string value) => value.StartsWith("--port=", StringComparison.OrdinalIgnoreCase));
		if (text != null)
		{
			TrySetPort(text.Substring("--port=".Length));
		}
		int idx = Array.FindIndex(args, (string value) => value.Equals("--port", StringComparison.OrdinalIgnoreCase));
		if (idx >= 0 && idx + 1 < args.Length)
		{
			TrySetPort(args[idx + 1]);
		}
		text = args.FirstOrDefault((string value) => value.StartsWith("--listen=", StringComparison.OrdinalIgnoreCase));
		if (text != null)
		{
			var l = text.Substring("--listen=".Length).Trim();
			if (l.Length > 0)
			{
				Config.listen = NormalizeListen(l);
			}
		}
	}

	private void TrySetPort(string raw)
	{
		if (int.TryParse(raw.Trim(), out var p) && p > 0 && p < 65536)
		{
			Config.port = p;
		}
	}

	private static string NormalizeListen(string raw)
	{
		return raw.ToLowerInvariant() switch
		{
			"localhost" or "127.0.0.1" or "local" => "127.0.0.1",
			"0.0.0.0" or "ipv4" or "lan" => "0.0.0.0",
			"[::]" or "::" or "ipv6" => "[::]",
			"*" or "all" or "any" => "*",
			_ => "127.0.0.1"
		};
	}

	public void Start()
	{
		string webRoot = ResolveWebRoot();
		var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
		{
			ApplicationName = "ZytbSiteHost",
			ContentRootPath = AppContext.BaseDirectory,
			WebRootPath = webRoot
		});
		builder.WebHost.UseUrls(Config.BuildPrefixes());
		builder.Logging.ClearProviders();
		var app = builder.Build();
		var fileProvider = new PhysicalFileProvider(webRoot);
		app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
		app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });
		app.Map("/proxy/{**target}", (HttpContext ctx, string? target) => ProxyForwarder.ProxyAsync(ctx, target));
		app.Map("/proxy", (HttpContext ctx) => ProxyForwarder.ProxyAsync(ctx, ctx.Request.Query["u"].ToString()));
		app.MapFallbackToFile("index.html", new StaticFileOptions { FileProvider = fileProvider });
		app.Start();
		App = app;
		Urls = Config.BuildPrefixes();
		try
		{
			Directory.CreateDirectory(DataDirectory);
			File.WriteAllText(Path.Combine(DataDirectory, "current-url.txt"), LocalUrl);
		}
		catch
		{
		}
	}

	public void Stop()
	{
		try
		{
			App?.StopAsync(new CancellationTokenSource(TimeSpan.FromSeconds(3)).Token).GetAwaiter().GetResult();
		}
		catch
		{
		}
		finally
		{
			App = null;
		}
	}

	/** 应用新配置：写盘 → 停止 → 重新启动；失败时回滚旧配置并恢复运行 */
	public void Apply(AppConfig newConfig)
	{
		var old = Config;
		Config = newConfig;
		Config.Save();
		Stop();
		try
		{
			Start();
		}
		catch
		{
			Config = old;
			Config.Save();
			Stop();
			Start();
			throw;
		}
	}

	private static string ResolveWebRoot()
	{
		string text = Path.Combine(AppContext.BaseDirectory, "wwwroot");
		if (!Directory.Exists(text))
		{
			throw new DirectoryNotFoundException("找不到站点目录 wwwroot。");
		}
		return text;
	}

	private static int ReserveFreePort()
	{
		for (int i = 0; i < 32; i++)
		{
			TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
			try
			{
				listener.Start();
				int port = ((IPEndPoint)listener.LocalEndpoint).Port;
				listener.Stop();
				return port;
			}
			catch (SocketException)
			{
			}
			finally
			{
				try { listener.Stop(); } catch { }
			}
		}
		throw new InvalidOperationException("找不到可用的本机端口。");
	}

	/** 列出本机可用于外部访问的地址（排除回环与链路本地；IPv6 加方括号）。用网卡枚举，不做 DNS 反查。 */
	public static string[] GetExternalAddresses()
	{
		try
		{
			return System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
				.Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up)
				.SelectMany(n => n.GetIPProperties().UnicastAddresses)
				.Select(u => u.Address)
				.Where(a => !IPAddress.IsLoopback(a))
				.Where(a => a.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
				.Where(a => !(a.IsIPv6LinkLocal || a.IsIPv6SiteLocal))
				.Select(a => a.AddressFamily == AddressFamily.InterNetworkV6 ? $"[{a}]" : a.ToString())
				.Distinct()
				.ToArray();
		}
		catch
		{
			return Array.Empty<string>();
		}
	}
}
