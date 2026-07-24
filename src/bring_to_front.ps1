$type = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
Add-Type -MemberDefinition $type -Name 'Win32' -Namespace 'Win32API' -PassThru | Out-Null
$chromeProcesses = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($chrome in $chromeProcesses) {
    [Win32API.Win32]::ShowWindow($chrome.MainWindowHandle, 9)
    [Win32API.Win32]::SetForegroundWindow($chrome.MainWindowHandle)
}
