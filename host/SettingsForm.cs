using System;
using System.Drawing;
using System.Windows.Forms;

namespace ZytbSiteHost;

/// <summary>端口 / 监听范围 / 浏览器行为设置。</summary>
internal sealed class SettingsForm : Form
{
	private readonly NumericUpDown _port = new();
	private readonly ComboBox _listen = new();
	private readonly CheckBox _openBrowser = new();
	private readonly TextBox _hint = new();
	private readonly Label _busy = new();
	private readonly Button _okButton;
	private readonly Button _cancelButton;

	/// <summary>点击确定后触发（携带新配置）</summary>
	public event Action<AppConfig>? OnApply;

	public SettingsForm(AppConfig config)
	{
		Text = "设置 · 中育ToolBox";
		StartPosition = FormStartPosition.CenterParent;
		FormBorderStyle = FormBorderStyle.FixedDialog;
		MaximizeBox = false;
		MinimizeBox = false;
		AutoSize = true;
		AutoSizeMode = AutoSizeMode.GrowAndShrink;
		Font = new Font("Microsoft YaHei UI", 9.5f);
		Padding = new Padding(14);

		var layout = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill, Padding = new Padding(4) };
		layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
		layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
		Controls.Add(layout);

		void AddRow(string label, Control control)
		{
			layout.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 8, 8, 3) });
			control.Width = 300;
			layout.Controls.Add(control);
		}

		_port.Minimum = 1;
		_port.Maximum = 65535;
		_port.Value = config.port;
		AddRow("端口", _port);

		_listen.DropDownStyle = ComboBoxStyle.DropDownList;
		_listen.Items.AddRange(new object[]
		{
			"仅本机（127.0.0.1）",
			"IPv4 所有网卡（0.0.0.0，局域网/外网）",
			"IPv6 所有网卡（[::]，局域网/外网）",
			"全部（*，IPv4 + IPv6）"
		});
		_listen.SelectedIndex = config.listen switch
		{
			"0.0.0.0" => 1,
			"[::]" => 2,
			"*" => 3,
			_ => 0
		};
		AddRow("监听范围", _listen);

		_openBrowser.Text = "启动时自动打开浏览器（仅本机地址）";
		_openBrowser.Checked = config.openBrowser;
		_openBrowser.AutoSize = true;
		AddRow("浏览器", _openBrowser);

		_hint.Multiline = true;
		_hint.ReadOnly = true;
		_hint.BackColor = Color.White;
		_hint.Height = 64;
		_hint.Width = 470;
		_hint.Text = "端口在首次启动时随机生成并固定，之后一直不变；在这里可自行修改。\r\n" +
			"监听范围改为局域网/外网后，其它设备可用 http:<本机IP>:<端口> 访问；\r\n" +
			"首次使用系统防火墙可能弹窗，请选择「允许」；若经公网访问还需在路由器上做端口映射。";
		layout.Controls.Add(_hint);
		layout.SetColumnSpan(_hint, 2);
		_busy.Text = string.Empty;
		_busy.ForeColor = Color.Firebrick;
		_busy.AutoSize = true;
		_busy.Margin = new Padding(0, 4, 0, 4);
		layout.Controls.Add(_busy);
		layout.SetColumnSpan(_busy, 2);

		var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
		var ok = new Button { Text = "确定", AutoSize = true, DialogResult = DialogResult.OK };
		var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
		_okButton = ok;
		_cancelButton = cancel;
		ok.Click += delegate
		{
			var cfg = new AppConfig
			{
				port = (int)_port.Value,
				listen = _listen.SelectedIndex switch
				{
					1 => "0.0.0.0",
					2 => "[::]",
					3 => "*",
					_ => "127.0.0.1"
				},
				openBrowser = _openBrowser.Checked
			};
			OnApply?.Invoke(cfg);
		};
		buttons.Controls.Add(cancel);
		buttons.Controls.Add(ok);
		layout.Controls.Add(buttons);
		layout.SetColumnSpan(buttons, 2);

		AcceptButton = ok;
		CancelButton = cancel;
	}

	/// <summary>应用配置期间禁用按钮并显示提示（耗时操作在后台线程进行，不卡界面）</summary>
	public void SetBusy(bool busy, string message)
	{
		_okButton.Enabled = !busy;
		_cancelButton.Enabled = !busy;
		_busy.Text = message ?? string.Empty;
	}
}
