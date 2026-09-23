using System;

namespace ZytbSiteHost;

/// <summary>
/// 入口只做两件事：runtime\ 程序集解析器由模块初始化器注册（先于本方法执行），
/// 然后进入程序主体。入口本身不得引用 WinForms / ASP.NET 等已移动到 runtime\ 的程序集。
/// </summary>
internal static class Program
{
	[STAThread]
	private static void Main(string[] args)
	{
		AppMain.Run(args);
	}
}
