param(
  [string]$ApiBase = 'http://127.0.0.1:3001/api/v1',
  [string]$WebOrigin = 'http://127.0.0.1:5173',
  [string]$BusinessSlug = 'demo-salon',
  [string]$Date = '',
  [int]$DurationMinutes = 60
)
$ErrorActionPreference = 'Stop'
if ($Date) { $apiDate = [datetime]::ParseExact($Date, 'dd-MM-yyyy', [System.Globalization.CultureInfo]::InvariantCulture).ToString('yyyy-MM-dd') }
$headers = @{ Origin = $WebOrigin; 'X-Flowpilot-Client' = 'web' }
$session = Invoke-RestMethod -Method Post -Uri "$ApiBase/customer/sessions" -Headers $headers -ContentType 'application/json' -Body (@{ businessSlug = $BusinessSlug } | ConvertTo-Json -Compress) -SessionVariable customerWebSession
try {
  if (!$Date) {
    $day = [datetime]::ParseExact($session.today, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture).AddDays(1)
    $apiDate = $day.ToString('yyyy-MM-dd')
  }
  $services = Invoke-RestMethod -Uri "$ApiBase/customer/services" -WebSession $customerWebSession
  if (!$services.items.Count) { throw 'No active service is available.' }
  $serviceId = $services.items[0].id
  $available = Invoke-RestMethod -Uri "$ApiBase/customer/availability?date=$apiDate&serviceId=$serviceId&durationMinutes=$DurationMinutes" -WebSession $customerWebSession
  if (!$available.items.Count) { throw 'No complete future appointment is available. Choose a seeded weekday with -Date dd-MM-yyyy.' }
  $selected = $available.items[0]
  $headers['Idempotency-Key'] = 'manual-proposal-' + [guid]::NewGuid().ToString()
  $selection = @{ slotId = $selected.slotId; serviceId = $serviceId; durationMinutes = $DurationMinutes } | ConvertTo-Json -Compress
  $proposal = Invoke-RestMethod -Method Post -Uri "$ApiBase/customer/booking-proposals" -Headers $headers -ContentType 'application/json' -Body $selection -WebSession $customerWebSession
  try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById($proposal.timezone) }
  catch {
    # Windows PowerShell/.NET Framework may require the Windows zone identifier.
    $windowsZone = switch ($proposal.timezone) {
      'Australia/Brisbane' { 'E. Australia Standard Time' }
      'America/New_York' { 'Eastern Standard Time' }
      default { throw 'This manual client cannot resolve the business timezone. No booking was submitted.' }
    }
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($windowsZone)
  }
  $start = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::Parse($proposal.startAt).ToUniversalTime(), $zone).ToString('dd-MM-yyyy HH:mm')
  $end = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::Parse($proposal.endAt).ToUniversalTime(), $zone).ToString('dd-MM-yyyy HH:mm')
  $expires = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::Parse($proposal.expiresAt).ToUniversalTime(), $zone).ToString('dd-MM-yyyy HH:mm:ss')
  Write-Output "Review SYNTHETIC appointment: $($proposal.serviceName), $($proposal.staffName), $DurationMinutes minutes."
  Write-Output "$start to $end ($($proposal.timezone))."
  Write-Output "Proposal expires $expires ($($proposal.timezone)); no slots are held before confirmation."
  Write-Output 'Confirming will reserve local demo inventory. No external provider or notification is involved.'
  $answer = Read-Host 'Type CONFIRM to book this displayed proposal; anything else stops here'
  if ($answer -cne 'CONFIRM') { Write-Output 'No booking submitted.'; return }
  $headers['Idempotency-Key'] = 'manual-confirm-' + [guid]::NewGuid().ToString()
  $body = @{ proposalId = $proposal.id; customer = @{ name = 'Synthetic Customer'; email = 'demo@example.test' } } | ConvertTo-Json -Compress
  $first = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$ApiBase/customer/bookings" -Headers $headers -ContentType 'application/json' -Body $body -WebSession $customerWebSession
  $again = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$ApiBase/customer/bookings" -Headers $headers -ContentType 'application/json' -Body $body -WebSession $customerWebSession
  if ($first.StatusCode -ne 201 -or $again.StatusCode -ne 200 -or $first.Content -ne $again.Content) { throw 'Expected one booking and an identical successful replay.' }
  $booking = $first.Content | ConvertFrom-Json
  $saved = Invoke-RestMethod -Uri "$ApiBase/customer/bookings/$($booking.id)" -WebSession $customerWebSession
  if ($saved.id -ne $booking.id -or $saved.reference -ne $booking.reference) { throw 'Owned booking read did not match confirmation.' }
  $after = Invoke-RestMethod -Uri "$ApiBase/customer/availability?date=$apiDate&serviceId=$serviceId&durationMinutes=$DurationMinutes&pageSize=50" -WebSession $customerWebSession
  if (@($after.items | Where-Object { $_.slotId -eq $selected.slotId }).Count) { throw 'Booked start is still offered as available.' }
  Write-Output "PASS: booking $($booking.reference), status $($booking.status), create 201 / replay 200 / owned read 200."
  Write-Output "Booked $start to $end ($($proposal.timezone)); $($DurationMinutes / 30) base slots reserved."
  Write-Output 'This synthetic booking remains in demo history. Inspect RESERVED slots in the dashboard. Cancellation is not implemented yet.'
} finally {
  Invoke-RestMethod -Method Post -Uri "$ApiBase/customer/logout" -Headers $headers -ContentType 'application/json' -Body '{}' -WebSession $customerWebSession | Out-Null
}
