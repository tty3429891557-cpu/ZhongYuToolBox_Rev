using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace ZytbSiteHost;

/// <summary>
/// 把托管程序集统一放在 runtime\ 子文件夹，通过 AssemblyResolve 从那里加载。
/// 必须在任何被移动的程序集加载之前注册，因此使用 ModuleInitializer
/// （它先于 Main 执行）。注意：本文件只能引用核心库（AppDomain/Path/File/Assembly），
/// 绝不能引用已移动到 runtime\ 的程序集（WinForms/AspNetCore 等）。
/// </summary>
internal static class ProbeInit
{
	private const string SubDir = "runtime";

	[ModuleInitializer]
	internal static void Register()
	{
		AppDomain.CurrentDomain.AssemblyResolve += (sender, e) =>
		{
			try
			{
				var an = new AssemblyName(e.Name);
				if (string.IsNullOrWhiteSpace(an.Name)) return null;
				var name = an.Name + ".dll";
				var root = Path.Combine(AppContext.BaseDirectory, SubDir);
				var culture = an.CultureName ?? string.Empty;
				if (culture.Length > 0 && !culture.Equals("neutral", StringComparison.OrdinalIgnoreCase))
				{
					var sat = Path.Combine(root, culture, name);
					if (File.Exists(sat)) return Assembly.LoadFrom(sat);
				}
				var p = Path.Combine(root, name);
				return File.Exists(p) ? Assembly.LoadFrom(p) : null;
			}
			catch
			{
				return null;
			}
		};
	}
}
