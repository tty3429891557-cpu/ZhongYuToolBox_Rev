using System;
using System.Diagnostics;
using System.Windows.Forms;

namespace ZytbSiteHost;

/// <summary>
/// 程序主体。放在独立类型里，使入口 Main 的 IL 不引用任何已移动到 runtime\ 的程序集，
/// 从而保证 AssemblyResolve 解析器先行注册。
/// </summary>
internal static class AppMain
{
	public static void Run(string[] args)
	{
		Application.SetHighDpiMode(HighDpiMode.SystemAware);
		Application.EnableVisualStyles();
		Application.SetCompatibleTextRenderingDefault(defaultValue: false);
		bool openBrowser = !args.Contains<string>("--no-browser", StringComparer.OrdinalIgnoreCase);

		var controller = new HostController();
		try
		{
			controller.LoadOrCreate(args);
			controller.Start();
		}
		catch (Exception ex)
		{
			try
			{
				var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZytbSiteHost");
				Directory.CreateDirectory(dir);
				File.WriteAllText(Path.Combine(dir, "startup-error.txt"), $"{DateTimeOffset.Now:O}\n{ex}");
			}
			catch { }

			MessageBox.Show("本地站点启动失败：" + ex.Message + "\n\n" +
				"如果指定了 --port，请换一个未被占用的端口；\n" +
				"或删除配置文件后重新启动（会重新随机分配端口）。\n" +
				"配置位置：%LOCALAPPDATA%\\ZytbSiteHost\\config.json",
				"中育ToolBox", MessageBoxButtons.OK, MessageBoxIcon.Hand);
			return;
		}

		if (openBrowser && controller.Config.openBrowser)
		{
			try
			{
				Process.Start(new ProcessStartInfo(controller.LocalUrl) { UseShellExecute = true });
			}
			catch { }
		}
		Application.Run(new StatusWindow(controller));
	}
}
