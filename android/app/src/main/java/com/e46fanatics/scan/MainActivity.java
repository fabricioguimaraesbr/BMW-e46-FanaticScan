package com.e46fanatics.scan;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UsbBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
