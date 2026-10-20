# PyInstaller build of the desktop app (one folder, no console): python -m PyInstaller PaperTrader.spec
# The UI must be built first (ui: npm run build), because it ships inside papertrader/static.

from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
)

import papertrader

numbers = tuple(int(part) for part in papertrader.__version__.split(".")) + (0,)
about = {
    "CompanyName": "Georgy Esik",
    "FileDescription": "Paper Trader",
    "FileVersion": papertrader.__version__,
    "InternalName": "PaperTrader",
    "LegalCopyright": "Copyright 2026 Georgy Esik",
    "OriginalFilename": "PaperTrader.exe",
    "ProductName": "Paper Trader",
    "ProductVersion": papertrader.__version__,
}
version = VSVersionInfo(
    ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
    kids=[
        StringFileInfo([StringTable("040904B0", [StringStruct(k, v) for k, v in about.items()])]),
        VarFileInfo([VarStruct("Translation", [1033, 1200])]),
    ],
)

a = Analysis(
    ["launcher.py"],
    datas=[("papertrader/static", "papertrader/static"), ("papertrader/schema.sql", "papertrader")],
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PIL"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="PaperTrader", console=False, icon="assets/icon.ico",
          version=version, upx=False)
COLLECT(exe, a.binaries, a.datas, name="PaperTrader", upx=False)
