{
  "targets": [
    {
      "target_name": "shelf_mutex",
      "sources": ["src/shelf_mutex.cc"],
      "defines": [
        "NAPI_VERSION=8",
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN"
      ],
      "libraries": ["Advapi32.lib"],
      "conditions": [
        ["OS!='win'", {
          "sources": []
        }]
      ],
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
