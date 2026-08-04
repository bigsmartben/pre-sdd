import 'package:flutter/widgets.dart';

class SpecPlaceholder extends StatelessWidget {
  const SpecPlaceholder({required this.widgetId, super.key});
  final String widgetId;

  @override
  Widget build(BuildContext context) => Semantics(
        identifier: widgetId,
        child: const Text('Implement the authorized Visual Spec here.'),
      );
}
