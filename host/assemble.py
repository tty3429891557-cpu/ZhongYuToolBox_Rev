#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""组装 中育ToolBox 程序目录：
   1. dotnet publish 多文件自包含
   2. 把非必要托管 DLL 归拢到 runtime\\（原生运行库留根）
   3. 放入站点 dist 到 wwwroot\\，附带 tbHelper 独立备用代理与启动脚本
用法：python assemble.py
"""
import os, shutil, subprocess, sys

HOST = r'E:\loshop-preservation-20260922\_work\ZytbSiteHost'
DIST = r'E:\loshop-preservation-20260922\sources\ZhongYuToolBox_Rev\dist'
PUB = r'E:\loshop-preservation-20260922\_work\newsite\publish-multi'
PS1 = r'E:\loshop-preservation-20260922\_work\author-src\local-proxy.ps1'

KEEP = {
 '中育ToolBox.exe','中育ToolBox.dll','中育ToolBox.deps.json','中育ToolBox.runtimeconfig.json',
 'hostfxr.dll','hostpolicy.dll','coreclr.dll','clrjit.dll','clrgc.dll','clrgcexp.dll','clretwrc.dll',
 'mscordaccore.dll','mscordbi.dll','mscorrc.dll','msquic.dll','createdump.exe',
 'System.Private.CoreLib.dll','System.Runtime.dll','netstandard.dll',
 'aspnetcorev2_inprocess.dll','vcruntime140_cor3.dll','vcruntime140_1_cor3.dll',
 'D3DCompiler_47_cor3.dll','PenImc_cor3.dll','nethost.dll','clrcompression.dll',
}
PREFIX_KEEP = ('mscordaccore_amd64', 'api-ms-win-')

def main():
    # 1) 发布
    if os.path.exists(PUB):
        shutil.rmtree(PUB, ignore_errors=True)
    r = subprocess.run(['dotnet','publish','-c','Release','-r','win-x64','--self-contained','true',
                        '-o',PUB], cwd=HOST, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-2000:]); print(r.stderr[-2000:]); sys.exit('发布失败')
    print('发布完成')

    # 2) 归拢
    run_dir = os.path.join(PUB, 'runtime')
    os.makedirs(run_dir, exist_ok=True)
    moved = 0
    for name in os.listdir(PUB):
        src = os.path.join(PUB, name)
        if not os.path.isfile(src): continue
        if name in KEEP or name.startswith(PREFIX_KEEP) or name.endswith('.pdb'): continue
        shutil.move(src, os.path.join(run_dir, name)); moved += 1
    for name in list(os.listdir(PUB)):
        d = os.path.join(PUB, name)
        if os.path.isdir(d) and name not in ('wwwroot','tbHelper','runtime'):
            shutil.move(d, os.path.join(run_dir, name)); moved += 1
    print(f'归拢 {moved} 项到 runtime\\')

    # 3) 站点与附带文件
    www = os.path.join(PUB, 'wwwroot')
    os.makedirs(www, exist_ok=True)
    for item in os.listdir(DIST):
        s = os.path.join(DIST, item); d = os.path.join(www, item)
        if os.path.isdir(s): shutil.copytree(s, d, dirs_exist_ok=True)
        else: shutil.copy2(s, d)
    tb = os.path.join(PUB, 'tbHelper')
    os.makedirs(tb, exist_ok=True)
    shutil.copy2(PS1, os.path.join(tb, 'local-proxy.ps1'))
    bat = os.path.join(PUB, '启动本地代理.bat')
    with open(bat, 'w', encoding='ascii', newline='\r\n') as f:
        f.write('@echo off\r\ncd /d "%~dp0tbHelper"\r\n'
                'echo Starting ZhongYuToolBox local proxy on 127.0.0.1:5005 ...\r\n'
                'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tbHelper\\local-proxy.ps1"\r\n'
                'pause\r\n')

    root = sorted(os.listdir(PUB))
    print('根目录', len(root), '项:', ', '.join(root))
    print('runtime\\ 文件数:', len(os.listdir(run_dir)))
    print('wwwroot\\ 文件数:', sum(len(fs) for _,_,fs in os.walk(www)))

if __name__ == '__main__':
    main()
