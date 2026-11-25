{
  "targets": [
    {
      "target_name": "windows_integration",
      "sources": ["src/windows_integration.cc"],
      "defines": [
        "NAPI_VERSION=8",
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN"
      ],
      "libraries": ["Advapi32.lib", "Ole32.lib", "Shell32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"],
          "RuntimeLibrary": "0"
        },
        "VCLinkerTool": {
          "SubSystem": "2"
        }
      }
    },
    {
      "target_name": "windows_integration_test",
      "sources": ["src/windows_integration.cc"],
      "defines": [
        "NAPI_VERSION=8",
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN",
        "MAGINALIA_WI_TEST_SEAM=1"
      ],
      "libraries": ["Advapi32.lib", "Ole32.lib", "Shell32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"],
          "RuntimeLibrary": "0"
        },
        "VCLinkerTool": {
          "SubSystem": "2"
        }
      }
    }
  ]
}
