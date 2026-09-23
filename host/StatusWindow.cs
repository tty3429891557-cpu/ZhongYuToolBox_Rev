using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Hosting;

namespace ZytbSiteHost;

internal sealed class StatusWindow : Form
{
	private readonly HostController _controller;

	private readonly Label _urlLabel = new();
	private readonly Label _externalLabel = new();
	private readonly TextBox _urlBox = new();
	private readonly Label _stateLabel = new();

	public StatusWindow(HostController controller)
	{
		_controller = controller;
		Text = "中育ToolBox · 本地运行";
		base.Icon = LoadAppIcon();
		StartPosition = FormStartPosition.CenterScreen;
		FormBorderStyle = FormBorderStyle.FixedDialog;
		MaximizeBox = false;
		MinimizeBox = true;
		AutoSize = true;
		AutoSizeMode = AutoSizeMode.GrowAndShrink;
		Padding = new Padding(18, 16, 18, 16);
		Font = new Font("Microsoft YaHei UI", 9.5f);

		var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, Dock = DockStyle.Fill };
		Controls.Add(layout);

		layout.Controls.Add(new Label
		{
			Text = "本地站点正在运行",
			AutoSize = true,
			Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold)
		});
		layout.Controls.Add(new Label
		{
			Text = "站点文件来自工作文件夹里已保存的新版构建产物，本程序不改动其中任何内容。\n" +
			       "页面里的登录、抓题、图库、云笔记等操作仍由网页直接访问学校接口，本程序不保存任何数据。\n" +
			       "本程序内置本地代理（/proxy/），用于转发领创接口与加速资源，随本程序启动/停止。",
			AutoSize = true,
			Margin = new Padding(0, 8, 0, 10)
		});

		_urlBox.Text = _controller.LocalUrl;
		_urlBox.ReadOnly = true;
		_urlBox.Width = 420;
		_urlBox.Font = new Font("Consolas", 10f);
		_urlBox.Margin = new Padding(0, 0, 0, 10);
		layout.Controls.Add(_urlBox);

		_externalLabel.AutoSize = true;
		_externalLabel.Margin = new Padding(0, 0, 0, 10);
		layout.Controls.Add(_externalLabel);

		var flow = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
		layout.Controls.Add(flow);

		void AddButton(string text, Action onClick)
		{
			var b = new Button { Text = text, AutoSize = true };
			b.Click += delegate { onClick(); };
			flow.Controls.Add(b);
		}

		AddButton("在浏览器中打开", Open);
		AddButton("复制本机地址", () =>
		{
			try { Clipboard.SetText(_controller.LocalUrl); } catch { }
		});
		AddButton("设置…", ShowSettings);
		AddButton("退出并停止", Close);

		_stateLabel.AutoSize = true;
		_stateLabel.ForeColor = Color.DimGray;
		_stateLabel.Margin = new Padding(0, 6, 0, 0);
		layout.Controls.Add(_stateLabel);

		RefreshAddresses();
	}

	/** 刷新本机地址与外部访问提示（设置变更后调用） */
	private void RefreshAddresses()
	{
		_urlBox.Text = _controller.LocalUrl;
		var exposed = _controller.Config.IsExposed;
		var lines = new System.Collections.Generic.List<string>();
		lines.Add("监听范围：" + (_controller.Config.listen switch
		{
			"0.0.0.0" => "IPv4 所有网卡",
			"[::]" => "IPv6 所有网卡",
			"*" => "全部网卡（IPv4 + IPv6）",
			_ => "仅本机（127.0.0.1）"
		}) + $"，端口 {_controller.Config.port}（已固定，可在设置中修改）");

		if (exposed)
		{
			var addresses = HostController.GetExternalAddresses();
			if (addresses.Length > 0)
			{
				lines.Add("外部访问地址：");
				lines.AddRange(addresses.Select(a => "  http://" + a + ":" + _controller.Config.port));
			}
			else
			{
				lines.Add("外部访问地址：未检测到本机网卡地址，可用 http:<本机IP>:" + _controller.Config.port);
			}
			lines.Add("提示：首次开放外部访问时系统防火墙可能弹窗，请选择「允许」；经公网访问需在路由器做端口映射。");
			lines.Add("注意：开放访问后，内置代理接口对同网段设备同样可用，请勿在不信任的网络中开放。");
			_externalLabel.ForeColor = Color.Firebrick;
		}
		else
		{
			lines.Add("当前仅本机可访问；如需手机/平板/其它电脑访问，请在「设置…」中把监听范围改为局域网或外网。");
			_externalLabel.ForeColor = Color.DimGray;
		}
		_externalLabel.Text = string.Join("\n", lines);
	}

	private void ShowSettings()
	{
		var cfg = new AppConfig
		{
			port = _controller.Config.port,
			listen = _controller.Config.listen,
			openBrowser = _controller.Config.openBrowser
		};
		using var form = new SettingsForm(cfg);
		form.OnApply += delegate(AppConfig newConfig)
		{
			// 后台线程应用配置（重启站点与代理），避免阻塞界面
			form.SetBusy(true, "正在应用新配置（站点与代理重启中），请稍候…");
			UseWaitCursor = true;
			System.Threading.Tasks.Task.Run(delegate
			{
				Exception? err = null;
				try
				{
					_controller.Apply(newConfig);
				}
				catch (Exception ex)
				{
					err = ex;
				}
				base.BeginInvoke(delegate
				{
					UseWaitCursor = false;
					if (err == null)
					{
						RefreshAddresses();
						form.SetBusy(false, "新配置已应用。");
						form.Close();
					}
					else
					{
						form.SetBusy(false, "应用失败（已恢复原配置）：" + err.Message);
					}
				});
			});
		};
		form.ShowDialog(this);
		RefreshAddresses();
	}

	private void Open()
	{
		try
		{
			Process.Start(new ProcessStartInfo(_controller.LocalUrl) { UseShellExecute = true });
		}
		catch
		{
		}
	}

	private static Icon? LoadAppIcon()
	{
		try
		{
			Assembly executingAssembly = Assembly.GetExecutingAssembly();
			string text = executingAssembly.GetManifestResourceNames().FirstOrDefault((string value) => value.EndsWith("app.ico", StringComparison.OrdinalIgnoreCase));
			if (text == null) return null;
			using Stream stream = executingAssembly.GetManifestResourceStream(text);
			return (stream == null) ? null : new Icon(stream);
		}
		catch
		{
			return null;
		}
	}

	protected override void OnFormClosing(FormClosingEventArgs e)
	{
		base.OnFormClosing(e);
		try
		{
			_controller.Stop();
		}
		catch
		{
		}
	}
}
