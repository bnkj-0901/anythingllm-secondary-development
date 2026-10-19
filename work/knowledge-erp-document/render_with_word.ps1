param(
    [Parameter(Mandatory=$true)][string]$DocumentPath,
    [Parameter(Mandatory=$true)][string]$PdfPath
)
$ErrorActionPreference = 'Stop'
$kbWord = $null
$kbDocument = $null
try {
    $kbWord = New-Object -ComObject Word.Application
    $kbWord.Visible = $false
    $kbWord.DisplayAlerts = 0
    $kbWord.AutomationSecurity = 3
    $kbResolved = (Resolve-Path -LiteralPath $DocumentPath).Path
    $kbDocument = $kbWord.Documents.Open($kbResolved, $false, $true, $false)
    $kbDocument.Repaginate()
    $kbPageCount = $kbDocument.ComputeStatistics(2)
    $kbDocument.ExportAsFixedFormat($PdfPath, 17)
    Write-Output "Rendered document using Microsoft Word: $kbPageCount pages"
}
finally {
    if($null -ne $kbDocument){
        $kbDocument.Close(0)
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($kbDocument)
    }
    if($null -ne $kbWord){
        $kbWord.Quit(0)
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($kbWord)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
