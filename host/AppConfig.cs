using System;
using System.IO;
using System.Text.Json;

namespace ZytbSiteHost;

/// <summary>
/// 站点配置（%LOCALAPPDATA%\ZytbSiteHost\config.json）。
/// port：首次启动时随机选取并写入，之后保持不变（可手动修改/在设置界面更改）。
/// listen：监听范围。127.0.0.1=仅本机；0.0.0.0=IPv4 所有网卡；[::]=IPv6 所有网卡；*=全部（IPv4+IPv6）。
/// openBrowser：启动时是否自动打开浏览器。
/// </summary>
internal sealed class AppConfig
{
	public int port { get; set; }

	public string listen { get; set; } = "127.0.0.1";

	public bool openBrowser { get; set; } = true;

	private static string ConfigPath => Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
		"ZytbSiteHost", "config.json");

	private static readonly JsonSerializerOptions JsonOptions = new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		WriteIndented = true
	};

	public static string ConfigFile => ConfigPath;

	/** 读取配置；文件不存在或损坏时返回 null */
	public static AppConfig? Load()
	{
		try
		{
			if (!File.Exists(ConfigPath)) return null;
			var json = File.ReadAllText(ConfigPath);
			var cfg = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions);
			if (cfg == null || cfg.port <= 0 || cfg.port >= 65536) return null;
			if (string.IsNullOrWhiteSpace(cfg.listen)) return null;
			return cfg;
		}
		catch
		{
			return null;
		}
	}

	public void Save()
	{
		try
		{
			Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
			File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, JsonOptions));
		}
		catch
		{
		}
	}

	/** 监听前缀列表（Kestrel 格式） */
	public string[] BuildPrefixes()
	{
		var p = port;
		return listen switch
		{
			"0.0.0.0" => new[] { $"http://0.0.0.0:{p}/" },
			"[::]" => new[] { $"http://[::]:{p}/" },
			"*" => new[] { $"http://*:{p}/" },
			_ => new[] { $"http://127.0.0.1:{p}/" }
		};
	}

	/** 是否对外开放（非仅本机） */
	public bool IsExposed => listen != "127.0.0.1";
}
