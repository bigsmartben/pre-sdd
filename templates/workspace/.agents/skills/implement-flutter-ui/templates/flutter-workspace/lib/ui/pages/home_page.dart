import 'package:flutter/material.dart';
import '../widgets/spec_placeholder.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(
        body: SafeArea(child: Center(child: SpecPlaceholder(widgetId: 'ui.home.placeholder'))),
      );
}
