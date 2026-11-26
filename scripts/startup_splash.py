"""Lightweight native Win32 startup splash card for packaged VoxFigura launchers.

Zero external UI dependencies (no Qt, Pillow, or Tk required); paints a DPI-aware,
double-buffered lavender-paper preparation card matching StartupSplash.vue.

Run `python scripts/startup_splash.py --preview` to preview the startup sequence.
"""

from __future__ import annotations

import argparse
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
import sys
import threading
import time

VOXFIGURA_PALETTE = {
    "surface": "FAF8FE",
    "border": "DFD7EE",
    "line": "E2DAF0",
    "track": "EAE3F6",
    "accent": "4B3186",
    "accentLight": "9D82DC",
    "title": "271B44",
    "subtitle": "5F5678",
    "stage": "2A1F47",
    "body": "665D80",
    "footer": "776F8F",
    "badgeBg": "DDCDFF",
    "badgeInk": "39255E",
    "badgeWave": "F6EEFF",
    "badgeDot": "147452",
}

STAGE_COPY = {
    "starting": ("正在启动 VoxFigura", "正在检查运行文件并加载界面，请耐心等待。", 1),
    "runtime": ("正在检查声学与声道界面组件", "正在初始化工作台布局、主题皮肤与本地组件，请耐心等待。", 1),
    "assets": ("正在加载语音学字体与资源", "正在载入国际音标字库、等宽刻度字体与预渲染声道资源。", 2),
    "engine": ("正在探测物理声道引擎", "正在核验 VTL 2.4 本地物理引擎与端侧推理服务状态。", 3),
    "ready": ("主界面已准备就绪", "正在进入 VoxFigura 工作台。", 3),
}


def _rgb(hex_color: str) -> int:
    return (
        int(hex_color[0:2], 16)
        | (int(hex_color[2:4], 16) << 8)
        | (int(hex_color[4:6], 16) << 16)
    )


class _PaintStruct(c.Structure):
    _fields_ = [
        ("dc", w.HDC),
        ("erase", w.BOOL),
        ("rect", w.RECT),
        ("restore", w.BOOL),
        ("update", w.BOOL),
        ("reserved", w.BYTE * 32),
    ]


class _TriVertex(c.Structure):
    _fields_ = [
        ("x", w.LONG),
        ("y", w.LONG),
        ("r", w.WORD),
        ("g", w.WORD),
        ("b", w.WORD),
        ("a", w.WORD),
    ]


class _GradientRect(c.Structure):
    _fields_ = [("first", w.ULONG), ("second", w.ULONG)]


class _SplashCanvas:
    """DPI-scaled double-buffered GDI renderer for the VoxFigura splash card."""

    def __init__(self, user: c.WinDLL, dpi: int, palette: dict[str, str] | None = None) -> None:
        self.user = user
        self.dpi = max(96, dpi)
        self.palette = dict(VOXFIGURA_PALETTE if palette is None else palette)
        self.fonts: dict[tuple[str, int, int], w.HFONT] = {}
        self.gdi = c.WinDLL("gdi32", use_last_error=True)
        self.msimg = c.WinDLL("msimg32", use_last_error=True)

        def bind(dll: c.WinDLL, name: str, restype: object, *argtypes: object) -> None:
            fn = getattr(dll, name)
            fn.restype = restype
            fn.argtypes = argtypes

        bind(user, "GetClientRect", w.BOOL, w.HWND, c.POINTER(w.RECT))
        bind(user, "DrawTextW", c.c_int, w.HDC, w.LPCWSTR, c.c_int, c.POINTER(w.RECT), w.UINT)
        bind(
            user,
            "DrawIconEx",
            w.BOOL,
            w.HDC,
            c.c_int,
            c.c_int,
            w.HICON,
            c.c_int,
            c.c_int,
            w.UINT,
            w.HBRUSH,
            w.UINT,
        )
        bind(self.gdi, "CreateCompatibleDC", w.HDC, w.HDC)
        bind(self.gdi, "CreateCompatibleBitmap", w.HBITMAP, w.HDC, c.c_int, c.c_int)
        bind(self.gdi, "SelectObject", w.HGDIOBJ, w.HDC, w.HGDIOBJ)
        bind(self.gdi, "GetStockObject", w.HGDIOBJ, c.c_int)
        bind(self.gdi, "DeleteObject", w.BOOL, w.HGDIOBJ)
        bind(self.gdi, "DeleteDC", w.BOOL, w.HDC)
        bind(self.gdi, "CreateSolidBrush", w.HBRUSH, w.DWORD)
        bind(self.gdi, "CreatePen", w.HGDIOBJ, c.c_int, c.c_int, w.DWORD)
        bind(self.gdi, "RoundRect", w.BOOL, w.HDC, *([c.c_int] * 6))
        bind(self.gdi, "Ellipse", w.BOOL, w.HDC, *([c.c_int] * 4))
        bind(self.gdi, "CreateRoundRectRgn", w.HRGN, *([c.c_int] * 6))
        bind(self.gdi, "SelectClipRgn", c.c_int, w.HDC, w.HRGN)
        bind(self.gdi, "BitBlt", w.BOOL, w.HDC, c.c_int, c.c_int, c.c_int, c.c_int, w.HDC, c.c_int, c.c_int, w.DWORD)
        bind(self.gdi, "SetTextColor", w.DWORD, w.HDC, w.DWORD)
        bind(self.gdi, "SetBkMode", c.c_int, w.HDC, c.c_int)
        bind(self.gdi, "CreateFontW", w.HFONT, *([c.c_int] * 5), *([w.DWORD] * 8), w.LPCWSTR)
        bind(
            self.msimg,
            "GradientFill",
            w.BOOL,
            w.HDC,
            c.POINTER(_TriVertex),
            w.ULONG,
            c.POINTER(_GradientRect),
            w.ULONG,
            w.ULONG,
        )

    def px(self, value: float) -> int:
        return round(value * self.dpi / 96)

    def rect(self, x: float, y: float, width: float, height: float) -> w.RECT:
        return w.RECT(self.px(x), self.px(y), self.px(x + width), self.px(y + height))

    def font(self, face: str, size: int, weight: int) -> w.HFONT:
        key = (face, size, weight)
        if key not in self.fonts:
            handle = self.gdi.CreateFontW(
                -self.px(size), 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0, face
            )
            if not handle:
                raise c.WinError(c.get_last_error())
            self.fonts[key] = handle
        return self.fonts[key]

    def text(
        self,
        dc: w.HDC,
        value: str,
        box: tuple[float, float, float, float],
        *,
        size: int = 16,
        serif_latin: bool = False,
        color: str = "665D80",
        weight: int = 400,
        right: bool = False,
    ) -> None:
        face = "Times New Roman" if serif_latin else "KaiTi"
        prev = self.gdi.SelectObject(dc, self.font(face, size, weight))
        try:
            self.gdi.SetBkMode(dc, 1)
            self.gdi.SetTextColor(dc, _rgb(color))
            rect = self.rect(*box)
            self.user.DrawTextW(dc, value, -1, c.byref(rect), 0x824 | (2 if right else 0))
        finally:
            self.gdi.SelectObject(dc, prev)

    def rounded(
        self,
        dc: w.HDC,
        box: tuple[float, float, float, float],
        radius: float,
        fill: str,
        border: str | None = None,
    ) -> None:
        rect = self.rect(*box)
        brush = self.gdi.CreateSolidBrush(_rgb(fill))
        pen = self.gdi.CreatePen(0, max(1, self.px(1)), _rgb(border)) if border else self.gdi.GetStockObject(8)
        old_brush = self.gdi.SelectObject(dc, brush)
        old_pen = self.gdi.SelectObject(dc, pen)
        try:
            self.gdi.RoundRect(
                dc,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                self.px(radius * 2),
                self.px(radius * 2),
            )
        finally:
            self.gdi.SelectObject(dc, old_brush)
            self.gdi.SelectObject(dc, old_pen)
            self.gdi.DeleteObject(brush)
            if border:
                self.gdi.DeleteObject(pen)

    def gradient(
        self,
        dc: w.HDC,
        box: tuple[float, float, float, float],
        first: str,
        second: str,
        *,
        vertical: bool = False,
    ) -> None:
        rect = self.rect(*box)

        def vertex(x: int, y: int, hex_color: str) -> _TriVertex:
            return _TriVertex(
                x,
                y,
                int(hex_color[0:2], 16) * 256,
                int(hex_color[2:4], 16) * 256,
                int(hex_color[4:6], 16) * 256,
                0,
            )

        vertices = (_TriVertex * 2)(
            vertex(rect.left, rect.top, first),
            vertex(rect.right, rect.bottom, second),
        )
        mesh = _GradientRect(0, 1)
        self.msimg.GradientFill(dc, vertices, 2, c.byref(mesh), 1, int(vertical))

    def draw_brand_badge(self, dc: w.HDC, icon: w.HICON | None) -> None:
        if icon:
            self.user.DrawIconEx(dc, self.px(36), self.px(32), icon, self.px(72), self.px(72), 0, None, 3)
            return
        # Clean built-in VoxFigura vector-style emblem fallback when no .ico is attached
        p = self.palette
        self.rounded(dc, (36, 32, 72, 72), 18, p["badgeBg"], p["border"])
        self.rounded(dc, (49, 51, 46, 35), 14, p["badgeInk"])
        self.rounded(dc, (55, 65, 34, 6), 3, p["badgeWave"])
        dot_brush = self.gdi.CreateSolidBrush(_rgb(p["badgeDot"]))
        null_pen = self.gdi.GetStockObject(8)
        old_b = self.gdi.SelectObject(dc, dot_brush)
        old_p = self.gdi.SelectObject(dc, null_pen)
        try:
            self.gdi.Ellipse(dc, self.px(84), self.px(42), self.px(95), self.px(53))
        finally:
            self.gdi.SelectObject(dc, old_b)
            self.gdi.SelectObject(dc, old_p)
            self.gdi.DeleteObject(dot_brush)

    def draw(
        self,
        hwnd: w.HWND,
        target: w.HDC,
        icon: w.HICON | None,
        state: tuple[str, str, str, int, int, bool],
        motion: float,
    ) -> None:
        bounds = w.RECT()
        self.user.GetClientRect(hwnd, c.byref(bounds))
        width, height = bounds.right, bounds.bottom
        dc = self.gdi.CreateCompatibleDC(target)
        bitmap = self.gdi.CreateCompatibleBitmap(target, width, height)
        if not dc or not bitmap:
            if dc:
                self.gdi.DeleteDC(dc)
            if bitmap:
                self.gdi.DeleteObject(bitmap)
            raise c.WinError(c.get_last_error())
        old = self.gdi.SelectObject(dc, bitmap)
        try:
            p = self.palette
            self.rounded(dc, (0, 0, 620, 312), 17, p["surface"], p["border"])
            self.draw_brand_badge(dc, icon)
            self.text(dc, "VoxFigura", (128, 33, 452, 43), serif_latin=True, size=34, color=p["title"], weight=600)
            self.text(
                dc,
                "物理声道驱动的语音实验与声乐编曲平台",
                (130, 81, 452, 26),
                size=16,
                color=p["subtitle"],
            )
            self.gradient(dc, (36, 126, 548, 1), p["line"], p["surface"])

            _stage_key, label, body, step, percent, known = state
            self.text(dc, label, (36, 150, 453, 31), size=21, color=p["stage"])
            self.text(
                dc,
                f"{percent}%" if known else "…",
                (486, 145, 98, 39),
                size=32,
                serif_latin=True,
                color=p["accent"],
                right=True,
            )
            self.text(dc, body, (36, 189, 548, 25), size=15, color=p["body"])
            self.rounded(dc, (36, 232, 548, 10), 5, p["track"])

            if known:
                start, length = 36.0, 548.0 * percent / 100.0
            else:
                start, length = 36.0 + 448.0 * motion, 108.0

            if length > 0:
                rbox = self.rect(start, 232, max(length, 1), 10)
                region = self.gdi.CreateRoundRectRgn(
                    rbox.left, rbox.top, rbox.right, rbox.bottom, self.px(10), self.px(10)
                )
                self.gdi.SelectClipRgn(dc, region)
                try:
                    self.gradient(dc, (start, 232, max(length, 1), 10), p["accentLight"], p["accent"])
                finally:
                    self.gdi.SelectClipRgn(dc, None)
                    self.gdi.DeleteObject(region)

            self.text(dc, "主界面就绪后自动关闭此提示", (36, 264, 450, 25), size=14, color=p["footer"])
            self.text(
                dc,
                f"{step} / 3",
                (510, 264, 74, 25),
                size=16,
                serif_latin=True,
                color=p["footer"],
                right=True,
            )
            self.gdi.BitBlt(target, 0, 0, width, height, dc, 0, 0, 0x00CC0020)
        finally:
            self.gdi.SelectObject(dc, old)
            self.gdi.DeleteObject(bitmap)
            self.gdi.DeleteDC(dc)

    def close(self) -> None:
        for handle in self.fonts.values():
            self.gdi.DeleteObject(handle)
        self.fonts.clear()


class VoxFiguraSplashWindow:
    """Thread-hosted native Win32 splash card for packaged desktop startup."""

    def __init__(self, *, icon_path: str | Path | None = None, offscreen: bool = False) -> None:
        if sys.platform != "win32":
            raise RuntimeError("VoxFiguraSplashWindow is only supported on Windows.")
        self.icon_path = Path(icon_path) if icon_path else None
        self.offscreen = offscreen
        self.hwnd: w.HWND | None = None
        self.thread: threading.Thread | None = None
        self.failure: Exception | None = None
        self.stopped = threading.Event()
        self.visible = threading.Event()
        label, body, step = STAGE_COPY["starting"]
        self.state: tuple[str, str, str, int, int, bool] = ("starting", label, body, step, 0, False)

    def update(self, stage: str, percent: int | None = None) -> None:
        label, body, step = STAGE_COPY.get(stage, STAGE_COPY["starting"])
        known = percent is not None
        pct = min(100, max(0, int(percent))) if known else 0
        self.state = (stage, label, body, step, pct, known)
        if self.thread is None and not self.stopped.is_set():
            self.thread = threading.Thread(target=self._run, name="voxfigura-splash", daemon=True)
            self.thread.start()

    def _run(self) -> None:
        try:
            self._window_loop()
        except Exception as exc:  # pragma: no cover - defensive native thread guard
            self.failure = exc
            self.visible.set()

    def _window_loop(self) -> None:
        user = c.WinDLL("user32", use_last_error=True)
        kernel = c.WinDLL("kernel32", use_last_error=True)
        user.SetThreadDpiAwarenessContext.argtypes = (c.c_void_p,)
        user.SetThreadDpiAwarenessContext.restype = c.c_void_p
        prior_dpi = user.SetThreadDpiAwarenessContext(c.c_void_p(-4))

        canvas = _SplashCanvas(user, user.GetDpiForSystem())
        kernel.GetModuleHandleW.restype = w.HMODULE
        instance = kernel.GetModuleHandleW(None)
        user.LoadImageW.argtypes = (w.HINSTANCE, w.LPCWSTR, w.UINT, c.c_int, c.c_int, w.UINT)
        user.LoadImageW.restype = w.HANDLE
        user.DestroyIcon.argtypes = (w.HICON,)

        icon: w.HICON | None = None
        if self.icon_path and self.icon_path.is_file():
            loaded = user.LoadImageW(None, str(self.icon_path), 1, canvas.px(72), canvas.px(72), 0x10)
            icon = loaded or None

        proc_type = c.WINFUNCTYPE(c.c_ssize_t, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
        user.DefWindowProcW.argtypes = (w.HWND, w.UINT, w.WPARAM, w.LPARAM)
        user.DefWindowProcW.restype = c.c_ssize_t
        user.BeginPaint.argtypes = (w.HWND, c.POINTER(_PaintStruct))
        user.BeginPaint.restype = w.HDC
        user.EndPaint.argtypes = (w.HWND, c.POINTER(_PaintStruct))
        user.GetWindowRect.argtypes = (w.HWND, c.POINTER(w.RECT))
        user.InvalidateRect.argtypes = (w.HWND, c.POINTER(w.RECT), w.BOOL)
        user.UpdateWindow.argtypes = (w.HWND,)
        user.SetWindowRgn.argtypes = (w.HWND, w.HRGN, w.BOOL)
        user.PeekMessageW.argtypes = (c.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT)
        user.TranslateMessage.argtypes = (c.POINTER(w.MSG),)
        user.DispatchMessageW.argtypes = (c.POINTER(w.MSG),)
        user.DispatchMessageW.restype = c.c_ssize_t

        motion = 0.5

        @proc_type
        def window_proc(hwnd: w.HWND, msg: int, wp: int, lp: int) -> int:
            try:
                if msg == 0x10:
                    return 0
                if msg == 0x14:
                    return 1
                if msg == 0x0F:
                    paint = _PaintStruct()
                    dc = user.BeginPaint(hwnd, c.byref(paint))
                    try:
                        canvas.draw(hwnd, dc, icon, self.state, motion)
                    finally:
                        user.EndPaint(hwnd, c.byref(paint))
                    return 0
                if msg in (0x317, 0x318):
                    canvas.draw(hwnd, w.HDC(wp), icon, self.state, motion)
                    return 0
                if msg == 0x84:
                    bounds = w.RECT()
                    user.GetWindowRect(hwnd, c.byref(bounds))
                    y = c.c_short((lp >> 16) & 0xFFFF).value - bounds.top
                    return 2 if 0 <= y < canvas.px(126) else 1
            except Exception as exc:
                self.failure = exc
                self.stopped.set()
                return 0
            return user.DefWindowProcW(hwnd, msg, wp, lp)

        class _WindowClass(c.Structure):
            _fields_ = [
                ("style", w.UINT),
                ("proc", proc_type),
                ("classExtra", c.c_int),
                ("windowExtra", c.c_int),
                ("instance", w.HINSTANCE),
                ("icon", w.HICON),
                ("cursor", w.HANDLE),
                ("background", w.HBRUSH),
                ("menu", w.LPCWSTR),
                ("name", w.LPCWSTR),
            ]

        class_name = f"VoxFiguraSplash-{id(self):x}"
        cls = _WindowClass(0x20000, window_proc, 0, 0, instance, icon, None, None, None, class_name)
        user.RegisterClassW.argtypes = (c.POINTER(_WindowClass),)
        user.CreateWindowExW.argtypes = (
            w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD,
            c.c_int, c.c_int, c.c_int, c.c_int,
            w.HWND, w.HMENU, w.HINSTANCE, c.c_void_p,
        )
        user.CreateWindowExW.restype = w.HWND
        user.DestroyWindow.argtypes = (w.HWND,)
        user.UnregisterClassW.argtypes = (w.LPCWSTR, w.HINSTANCE)

        registered = False
        try:
            if not user.RegisterClassW(c.byref(cls)):
                raise c.WinError(c.get_last_error())
            registered = True
            width, height = canvas.px(620), canvas.px(312)
            x = -10000 if self.offscreen else (user.GetSystemMetrics(0) - width) // 2
            y = (user.GetSystemMetrics(1) - height) // 2
            self.hwnd = user.CreateWindowExW(
                0x40000,
                class_name,
                "VoxFigura · 正在启动",
                0x90000000,
                x,
                y,
                width,
                height,
                None,
                None,
                instance,
                None,
            )
            if not self.hwnd:
                raise c.WinError(c.get_last_error())
            region = canvas.gdi.CreateRoundRectRgn(0, 0, width + 1, height + 1, canvas.px(34), canvas.px(34))
            if not user.SetWindowRgn(self.hwnd, region, True):
                canvas.gdi.DeleteObject(region)
            user.UpdateWindow(self.hwnd)
            self.visible.set()

            message = w.MSG()
            previous = None
            while not self.stopped.wait(0.04):
                while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                    user.TranslateMessage(c.byref(message))
                    user.DispatchMessageW(c.byref(message))
                state = self.state
                if not state[5]:
                    phase = (time.monotonic() % 2.4) / 1.2
                    motion = phase if phase <= 1 else 2 - phase
                else:
                    motion = 0.5
                if state != previous or not state[5]:
                    user.InvalidateRect(self.hwnd, None, False)
                    user.UpdateWindow(self.hwnd)
                previous = state
        finally:
            if self.hwnd:
                user.DestroyWindow(self.hwnd)
            if registered:
                user.UnregisterClassW(class_name, instance)
            canvas.close()
            if icon:
                user.DestroyIcon(icon)
            if prior_dpi:
                user.SetThreadDpiAwarenessContext(prior_dpi)

    def close(self) -> None:
        self.stopped.set()
        if self.thread:
            self.thread.join(3)
        if self.failure:
            raise RuntimeError("VoxFigura 启动提示窗绘制失败。") from self.failure


def run_preview(*, icon_path: str | None = None, offscreen: bool = False, step_seconds: float = 0.75) -> None:
    splash = VoxFiguraSplashWindow(icon_path=icon_path, offscreen=offscreen)
    try:
        for stage, pct in [("runtime", 24), ("assets", 62), ("engine", 92), ("ready", 100)]:
            splash.update(stage, pct)
            splash.visible.wait(2.0)
            time.sleep(step_seconds)
    finally:
        splash.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Preview the native VoxFigura Windows startup splash card.")
    parser.add_argument("--preview", action="store_true", help="Run an animated preview sequence.")
    parser.add_argument("--offscreen", action="store_true", help="Render offscreen for headless smoke tests.")
    parser.add_argument("--icon", default=None, help="Optional path to a .ico application icon.")
    parser.add_argument("--step-seconds", type=float, default=0.75, help="Duration of each preview stage.")
    args = parser.parse_args()
    if args.preview or args.offscreen:
        run_preview(icon_path=args.icon, offscreen=args.offscreen, step_seconds=args.step_seconds)
    else:
        parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
