const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Windows selection script parses and every used UI Automation API exists', { skip: process.platform !== 'win32' }, () => {
  const scriptPath = path.join(__dirname, '../src/main/read-selection.ps1');
  const literalPath = "'" + scriptPath.replace(/'/g, "''") + "'";
  // Verify actual API call sites without reading the user's desktop selection.
  const validation = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${literalPath}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$staticCalls = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Static }, $true)
$checked = 0
$comparisons = 0
foreach ($call in $staticCalls) {
  if ($call.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]) { throw 'Unrecognized static call' }
  $typeName = $call.Expression.TypeName.FullName
  if ($typeName -eq 'VocaSelectionNative') { continue }
  $type = $call.Expression.TypeName.GetReflectionType()
  if ($null -eq $type) { throw "Unresolved static type: $typeName" }
  $methodName = $call.Member.Value
  $methods = @($type.GetMethods([System.Reflection.BindingFlags]'Public, Static') | Where-Object Name -eq $methodName)
  if ($methods.Count -eq 0) { throw "Missing static method: $typeName::$methodName" }
  $checked++
  if ($methodName -eq 'Compare') { $comparisons++ }
}
$instanceMethods = @(
  @{ Type = [System.Windows.Automation.AutomationElement]; Name = 'TryGetCurrentPattern' },
  @{ Type = [System.Windows.Automation.TreeWalker]; Name = 'GetParent' },
  @{ Type = [System.Windows.Automation.TextPattern]; Name = 'GetSelection' },
  @{ Type = [System.Windows.Automation.Text.TextPatternRange]; Name = 'GetText' }
)
foreach ($member in $instanceMethods) {
  $methods = @($member.Type.GetMethods([System.Reflection.BindingFlags]'Public, Instance') | Where-Object Name -eq $member.Name)
  if ($methods.Count -eq 0) { throw "Missing instance method: $($member.Type.FullName).$($member.Name)" }
}
$properties = @(
  @{ Type = [System.Windows.Automation.AutomationElement]; Name = 'FocusedElement' },
  @{ Type = [System.Windows.Automation.AutomationElement]; Name = 'Current' },
  @{ Type = [System.Windows.Automation.AutomationElement].GetNestedType('AutomationElementInformation'); Name = 'IsPassword' },
  @{ Type = [System.Windows.Automation.TextPattern]; Name = 'SupportedTextSelection' }
)
foreach ($member in $properties) {
  if ($null -eq $member.Type.GetProperty($member.Name)) { throw "Missing UIA property: $($member.Type.FullName).$($member.Name)" }
}
if ($null -eq [System.Windows.Automation.TextPattern].GetField('Pattern')) { throw 'TextPattern.Pattern does not exist' }
if ($null -eq [System.Windows.Automation.TreeWalker].GetField('RawViewWalker')) { throw 'TreeWalker.RawViewWalker does not exist' }
if ($null -eq [System.Windows.Automation.SupportedTextSelection].GetField('None')) { throw 'SupportedTextSelection.None does not exist' }
[pscustomobject]@{ parsed = $true; staticCallsChecked = $checked; compareCalls = $comparisons; instanceMethodsChecked = $instanceMethods.Count } | ConvertTo-Json -Compress
`;
  const child = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(validation, 'utf16le').toString('base64'),
  ], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(result.parsed, true);
  assert.ok(result.staticCallsChecked >= 7, 'checks script call sites, including Automation.Compare');
  assert.equal(result.compareCalls, 2, 'foreground ancestry and unchanged focus both compare actual UIA elements');
  assert.equal(result.instanceMethodsChecked, 4);
});
