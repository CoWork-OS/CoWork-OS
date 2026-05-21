$ErrorActionPreference = "Stop"

$accuracy = "precise"
$timeoutMs = 15000
$responseFile = ""

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--accuracy"      { $accuracy    = $args[++$i] }
        "--timeout-ms"    { $timeoutMs   = [int]$args[++$i] }
        "--response-file" { $responseFile = $args[++$i] }
    }
}

if ($timeoutMs -lt 1000)  { $timeoutMs = 1000 }
if ($timeoutMs -gt 60000) { $timeoutMs = 60000 }

function Emit-Result([string]$json) {
    if ($responseFile) {
        [System.IO.File]::WriteAllText($responseFile, $json, [System.Text.Encoding]::UTF8)
    } else {
        [Console]::Out.Write($json)
        [Console]::Out.Write("`n")
    }
}

function Emit-Error([string]$code, [string]$message) {
    $envelope = @{ ok = $false; error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress
    Emit-Result $envelope
    exit 1
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    $null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType=WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 })[0]

    function Await-WinRT($asyncOp, [Type]$resultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $task = $asTask.Invoke($null, @($asyncOp))
        if (-not $task.Wait($timeoutMs)) {
            Emit-Error "LOCATION_TIMEOUT" "Timed out while getting current location from Windows Location Services."
        }
        return $task.Result
    }

    $geolocator = New-Object Windows.Devices.Geolocation.Geolocator
    if ($accuracy -eq "coarse") {
        $geolocator.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::Default
    } else {
        $geolocator.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High
    }

    $position = Await-WinRT $geolocator.GetGeopositionAsync() ([Windows.Devices.Geolocation.Geoposition])

    $coord = $position.Coordinate
    $point = $coord.Point.Position
    $now   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $envelope = @{
        ok       = $true
        location = @{
            latitude      = $point.Latitude
            longitude     = $point.Longitude
            accuracyMeters = $coord.Accuracy
            timestamp     = $now
            source        = "windows_location"
        }
    } | ConvertTo-Json -Compress

    Emit-Result $envelope
    exit 0

} catch {
    $msg = $_.Exception.Message
    if ($msg -match "denied|not allowed|access is denied|disabled") {
        Emit-Error "LOCATION_DENIED" "Location access was denied by Windows."
    }
    Emit-Error "LOCATION_UNAVAILABLE" $msg
}
