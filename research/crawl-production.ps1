param([string]$OutputPath = 'research/production-crawl-2026-11-10.csv')

$ErrorActionPreference = 'Stop'
$origins = @('https://www.zapnivo.com', 'https://support.zapnivo.com')
$urls = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

foreach ($origin in $origins) {
  $raw = (& curl.exe -L -sS --max-time 30 "$origin/sitemap.xml") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Could not fetch sitemap at $origin" }
  [xml]$xml = $raw
  foreach ($entry in $xml.urlset.url) { [void]$urls.Add([string]$entry.loc) }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('zapnivo-crawl-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$rows = [System.Collections.Generic.List[object]]::new()
$linkStatus = [System.Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
try {
  foreach ($url in $urls) {
    $bodyFile = Join-Path $work 'body.html'
    $headerFile = Join-Path $work 'headers.txt'
    $summary = (& curl.exe -L -sS -A 'Googlebot' --max-time 30 -D $headerFile -o $bodyFile -w '%{http_code}|%{url_effective}|%{content_type}' -- $url) -join ''
    if ($LASTEXITCODE -ne 0) { throw "Could not fetch $url" }
    $parts = $summary.Split('|', 3)
    $body = Get-Content -LiteralPath $bodyFile -Raw
    $headers = Get-Content -LiteralPath $headerFile -Raw
    $canonical = [regex]::Match($body, '<link[^>]+rel="canonical"[^>]+href="([^"]+)"', 'IgnoreCase').Groups[1].Value
    $title = [Net.WebUtility]::HtmlDecode([regex]::Match($body, '<title[^>]*>(.*?)</title>', 'IgnoreCase, Singleline').Groups[1].Value)
    $description = [regex]::Match($body, '<meta[^>]+name="description"[^>]+content="([^"]*)"', 'IgnoreCase').Groups[1].Value
    $robots = [regex]::Match($body, '<meta[^>]+name="robots"[^>]+content="([^"]*)"', 'IgnoreCase').Groups[1].Value
    $xRobots = [regex]::Matches($headers, '(?im)^x-robots-tag:\s*(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() }
    $links = [regex]::Matches($body, '<a\b[^>]*href="([^"]+)"', 'IgnoreCase') | ForEach-Object { $_.Groups[1].Value }
    $broken = [System.Collections.Generic.List[string]]::new()
    $code = ''
    foreach ($href in $links) {
      if ($href -match '^(#|mailto:|tel:|javascript:)') { continue }
      try { $target = [uri]::new([uri]$parts[1], [Net.WebUtility]::HtmlDecode($href)) } catch { continue }
      if ($target.Host -notin @('www.zapnivo.com', 'zapnivo.com', 'support.zapnivo.com', 'customer.zapnivo.com', 'partners.zapnivo.com', 'internal.zapnivo.com')) { continue }
      if (-not $linkStatus.TryGetValue($target.AbsoluteUri, [ref]$code)) {
        $code = (& curl.exe -L -sS -I --max-time 20 -o NUL -w '%{http_code}' -- $target.AbsoluteUri) -join ''
        $linkStatus[$target.AbsoluteUri] = $code
      }
      if ($code -match '^[45]') { $broken.Add("$code $($target.AbsoluteUri)") }
    }
    $rows.Add([pscustomobject]@{
      Url = $url; Status = [int]$parts[0]; FinalUrl = $parts[1]; ContentType = $parts[2]
      Canonical = $canonical; Title = $title; Description = $description
      Robots = $robots; XRobots = ($xRobots -join '; '); InternalLinks = $links.Count
      BrokenInternalLinks = (($broken | Select-Object -Unique) -join '; ')
    })
    Write-Output "$($parts[0]) $url canonical=$canonical links=$($links.Count) broken=$($broken.Count)"
  }
  $rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
  Write-Output "Saved $($rows.Count) URLs to $OutputPath"
} finally {
  $resolved = (Resolve-Path -LiteralPath $work).Path
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $resolved.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temp cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
