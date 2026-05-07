# Mobile Build - Hướng Dẫn Sử Dụng

## Cấu Trúc Thư Mục

```
mobile_build/
├── index.html          # File HTML standalone (đã nhúng CSS, JS và levels.json)
└── data/               # Thư mục chứa 952 file JSON của từng level
    ├── animal_0.json
    ├── animal_1.json
    ├── ...
    └── halloween_58.json
```

## Cách Sử Dụng Trong Android (Kotlin)

### Bước 1: Copy vào Assets

Copy toàn bộ thư mục `mobile_build/` vào `app/src/main/assets/`:

```
app/src/main/assets/
├── index.html
└── data/
    ├── animal_0.json
    ├── ...
```

### Bước 2: Cấu Hình WebView

```kotlin
// MainActivity.kt hoặc Fragment
val webView = findViewById<WebView>(R.id.webView)

// Bật JavaScript
webView.settings.javaScriptEnabled = true

// Cho phép truy cập file
webView.settings.allowFileAccess = true
webView.settings.allowFileAccessFromFileURLs = true
webView.settings.allowUniversalAccessFromFileURLs = true

// Bật DOM Storage (cho localStorage)
webView.settings.domStorageEnabled = true

// Bật debugging (optional - để debug qua Chrome)
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
    WebView.setWebContentsDebuggingEnabled(true)
}

// Load file HTML
webView.loadUrl("file:///android_asset/index.html")
```

### Bước 3: (Optional) Bắt Console Log

Để debug lỗi nếu có:

```kotlin
webView.webChromeClient = object : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        Log.d("WebView", "${message.message()} -- Line ${message.lineNumber()}")
        return true
    }
}
```

## Tính Năng Đã Tối Ưu

✅ **Levels.json đã được nhúng** vào HTML → Không cần fetch file này nữa  
✅ **CSS và JS đã inline** → Giảm số lượng request  
✅ **Tự động detect Mobile Mode** → App sẽ ưu tiên dùng data đã preload  
✅ **Vẫn giữ folder data/** → Để load từng level khi user click chơi  

## Lưu Ý

- File `index.html` trong `mobile_build/` đã **tự động nhúng** file `levels.json` vào trong `<script>` tag.
- Khi app chạy, JavaScript sẽ kiểm tra `window.PRELOADED_LEVELS` trước, nếu có thì dùng luôn, không cần fetch.
- Folder `data/` vẫn cần thiết vì khi user click vào 1 bức tranh, app mới fetch file JSON chi tiết (VD: `data/animal_15.json`).

## Build Lại

Nếu bạn sửa code gốc và muốn build lại phiên bản mobile:

```powershell
.\build_mobile.ps1
```

Script sẽ tự động:
1. Đọc `index.html`, `app.js`, `style.css`, `data/levels.json`
2. Inline CSS và JS vào HTML
3. Nhúng `levels.json` vào biến `window.PRELOADED_LEVELS`
4. Copy folder `data/` sang `mobile_build/`
5. Tạo file `mobile_build/index.html` hoàn chỉnh
