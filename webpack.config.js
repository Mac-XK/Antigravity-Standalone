const path = require('path');
const webpack = require('webpack');

/** @type WebpackConfig */
const config = {
    mode: 'none',
    target: 'node', // Important for fs/net modules
    entry: {
        extension: './src/extension.ts',
    },
    output: {
        filename: '[name].js',
        path: path.join(__dirname, './dist'),
        libraryTarget: 'commonjs',
        devtoolModuleFilenameTemplate: '../../[resource-path]',
    },
    resolve: {
        mainFields: ['module', 'main'],
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                    },
                ],
            },
        ],
    },
    externals: {
        vscode: 'commonjs vscode',
        // express: 'commonjs express', // Try bundling express
    },
    performance: {
        hints: false,
    },
    devtool: 'nosources-source-map',
};

module.exports = config;
