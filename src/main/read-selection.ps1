param(
  [switch]$UsePoint,
  [int]$X = 0,
  [int]$Y = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VocaSelectionNative {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
'@
  $foreground = [VocaSelectionNative]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { return }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase

  $foregroundElement = [System.Windows.Automation.AutomationElement]::FromHandle($foreground)
  $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $foregroundElement -or $null -eq $focusedElement) { return }

  # An element is usable only when its full ancestor chain reaches the active
  # window and has no password control. Do not search other windows/documents.
  function Get-SafeAncestors($element) {
    $elements = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
    for ($depth = 0; $null -ne $element -and $depth -lt 64; $depth++) {
      if ($element.Current.IsPassword) { return }
      $elements.Add($element)
      if ([System.Windows.Automation.Automation]::Compare($element, $foregroundElement)) {
        return ,$elements
      }
      $element = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($element)
    }
  }

  $focusedAncestors = Get-SafeAncestors $focusedElement
  if ($null -eq $focusedAncestors) { return }

  if ($UsePoint) {
    # The drag endpoint must be in the same active window. Starting at the
    # pointed element avoids reusing a selection in some unrelated focused pane.
    $point = New-Object System.Windows.Point($X, $Y)
    $pointedElement = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $candidates = Get-SafeAncestors $pointedElement
  } else {
    $candidates = $focusedAncestors
  }
  if ($null -eq $candidates) { return }

  $selectedText = ''
  foreach ($element in $candidates) {
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      continue
    }
    if ($pattern.SupportedTextSelection -eq [System.Windows.Automation.SupportedTextSelection]::None) {
      continue
    }

    $parts = New-Object 'System.Collections.Generic.List[string]'
    $totalLength = 0
    # GetSelection returns only selected ranges. An insertion point is an empty
    # range. Never use DocumentRange, ValuePattern, or a simulated copy fallback.
    foreach ($range in $pattern.GetSelection()) {
      $separatorLength = if ($parts.Count -gt 0) { 1 } else { 0 }
      $remaining = 5000 - $totalLength - $separatorLength
      $part = $range.GetText([Math]::Max(1, $remaining + 1))
      if ([string]::IsNullOrEmpty($part)) { continue }
      if ($part.Length -gt $remaining) { return }
      $parts.Add($part)
      $totalLength += $part.Length + $separatorLength
    }
    $selectedText = [string]::Join("`n", $parts).Trim()
    if ($selectedText.Length -gt 0) { break }
  }

  # UI Automation providers run across processes. Discard answers if activation
  # or focused control changed while the provider was responding.
  if ([VocaSelectionNative]::GetForegroundWindow() -ne $foreground) { return }
  $currentFocus = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $currentFocus -or -not [System.Windows.Automation.Automation]::Compare($focusedElement, $currentFocus)) {
    return
  }
  ConvertTo-Json -InputObject $selectedText -Compress
} catch {
  # Unsupported, protected, inaccessible, or disappearing UIA controls have no
  # selection. The caller also bounds execution time and cancels stale requests.
}
