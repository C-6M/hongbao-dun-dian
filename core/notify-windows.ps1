$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json

if ($payload.url -notmatch '^https://live\.bilibili\.com/[0-9]+$' -and
    $payload.url -ne 'http://127.0.0.1:8443/pool') {
  throw 'Unsupported notification destination'
}
$expires = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$payload.expiresAt)
if ($expires -le [DateTimeOffset]::Now) { throw 'Notification already expired' }

# Register this unpackaged app for the current user; notification preferences are untouched.
$appId = 'RedpacketWatch.Scanner'
$appKey = 'HKCU:\Software\Classes\AppUserModelId\' + $appId
if (-not (Test-Path -LiteralPath $appKey)) {
  New-Item -Path $appKey -Force > $null
  New-ItemProperty -LiteralPath $appKey -Name 'DisplayName' -Value (-join [char[]]@(0x7ea2, 0x5305, 0x8e72, 0x70b9)) -PropertyType String > $null
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$setting = $null
try { $setting = $notifier.get_Setting() }
catch {
  # Some desktops have no stored settings entry yet. Show still reports delivery errors.
  if ($_.Exception.InnerException.HResult -ne -2147023728) { throw }
}
if ($null -ne $setting -and $setting.ToString() -ne 'Enabled') { throw ('Windows notifications: ' + $setting) }

$title = [System.Security.SecurityElement]::Escape([string]$payload.title)
$body = [System.Security.SecurityElement]::Escape([string]$payload.body)
$url = [System.Security.SecurityElement]::Escape([string]$payload.url)
$button = [System.Security.SecurityElement]::Escape([string]$payload.button)
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml('<toast activationType="protocol" launch="' + $url + '" duration="long"><visual><binding template="ToastGeneric"><text>' +
  $title + '</text><text>' + $body + '</text></binding></visual><actions><action activationType="protocol" content="' +
  $button + '" arguments="' + $url + '"/></actions><audio src="ms-winsoundevent:Notification.Default"/></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = ([string]$payload.id).Substring(0, [Math]::Min(16, ([string]$payload.id).Length))
$toast.Group = 'redpacket-alerts'
$toast.ExpirationTime = $expires
$notifier.Show($toast)
[Console]::WriteLine('{"submitted":true}')
